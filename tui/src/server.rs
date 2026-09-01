//! `piw serve`: a loopback-only, one-WebSocket-to-one-host-socket relay.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

pub struct ServeOptions {
    pub socket_path: PathBuf,
    pub bind: String,
}

pub async fn serve(options: ServeOptions) -> Result<()> {
    let listener = TcpListener::bind(&options.bind)
        .await
        .with_context(|| format!("binding {}", options.bind))?;
    eprintln!(
        "piw serve: relaying {} on ws://{}/ws",
        options.socket_path.display(),
        listener.local_addr()?
    );
    serve_on(listener, options.socket_path).await
}

pub async fn serve_on(listener: TcpListener, socket_path: PathBuf) -> Result<()> {
    let local = listener.local_addr()?;
    if !local.ip().is_loopback() {
        anyhow::bail!(
            "refusing to serve on non-loopback address {local}: the client protocol is unauthenticated"
        );
    }
    loop {
        let (stream, _) = listener.accept().await?;
        let socket_path = socket_path.clone();
        tokio::spawn(async move {
            if let Err(error) = relay(stream, socket_path).await {
                eprintln!("piw serve connection: {error:#}");
            }
        });
    }
}

#[allow(clippy::result_large_err)] // Required by tungstenite's handshake callback type.
async fn relay(stream: TcpStream, socket_path: PathBuf) -> Result<()> {
    let websocket =
        tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
            validate_request(request, response)
        })
        .await
        .context("accepting WebSocket")?;
    #[cfg(unix)]
    {
        let host = UnixStream::connect(&socket_path)
            .await
            .with_context(|| format!("connecting to workflow host {}", socket_path.display()))?;
        relay_host(websocket, host).await
    }
    #[cfg(windows)]
    {
        let host = ClientOptions::new()
            .open(&socket_path)
            .with_context(|| format!("connecting to workflow host {}", socket_path.display()))?;
        relay_host(websocket, host).await
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("local workflow host transport is not supported on this platform");
}

async fn relay_host<S>(
    websocket: tokio_tungstenite::WebSocketStream<TcpStream>,
    host: S,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut ws_sink, mut ws_stream) = websocket.split();
    let (host_read, mut host_write) = tokio::io::split(host);
    let mut host_lines = BufReader::new(host_read).lines();
    loop {
        tokio::select! {
            host_line = host_lines.next_line() => {
                let Some(line) = host_line.context("reading workflow host")? else { break };
                ws_sink.send(Message::Text(line.into())).await.context("sending WebSocket frame")?;
            }
            ws_message = ws_stream.next() => {
                let Some(message) = ws_message else { break };
                match message.context("reading WebSocket frame")? {
                    Message::Text(text) => {
                        if text.contains('\n') || text.contains('\r') {
                            anyhow::bail!("client frame contains a line break");
                        }
                        host_write.write_all(text.as_bytes()).await?;
                        host_write.write_all(b"\n").await?;
                        host_write.flush().await?;
                    }
                    Message::Close(_) => break,
                    Message::Ping(payload) => ws_sink.send(Message::Pong(payload)).await?,
                    Message::Pong(_) => {}
                    Message::Binary(_) | Message::Frame(_) => {
                        anyhow::bail!("client frame must be text");
                    }
                }
            }
        }
    }
    Ok(())
}

#[allow(clippy::result_large_err)] // Required by tungstenite's handshake callback type.
fn validate_request(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    if request.uri().path() != "/ws" {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "WebSocket path must be /ws",
        ));
    }
    if let Some(origin) = request.headers().get("origin") {
        let loopback = origin
            .to_str()
            .ok()
            .and_then(|value| {
                value
                    .parse::<tokio_tungstenite::tungstenite::http::Uri>()
                    .ok()
            })
            .and_then(|uri| uri.host().map(str::to_string))
            .is_some_and(|host| {
                matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1")
            });
        if !loopback {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "origin is not loopback",
            ));
        }
    }
    Ok(response)
}

fn error_response(status: StatusCode, message: &str) -> ErrorResponse {
    tokio_tungstenite::tungstenite::http::Response::builder()
        .status(status)
        .body(Some(message.to_string()))
        .expect("valid relay error response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    #[cfg(unix)]
    use tempfile::tempdir;
    #[cfg(unix)]
    use tokio::net::UnixListener;

    #[test]
    fn handshake_rejects_a_lookalike_loopback_origin() {
        let request = Request::builder()
            .uri("/ws")
            .header("origin", "http://localhost.evil")
            .body(())
            .unwrap();
        let response = Response::new(());
        let error = validate_request(&request, response).unwrap_err();
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn relay_rejects_a_non_loopback_listener() {
        let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let error = serve_on(listener, PathBuf::from("unused"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("non-loopback"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relay_couples_one_websocket_to_one_host_socket() {
        let temporary = tempdir().unwrap();
        let socket_path = temporary.path().join("host.sock");
        let host_listener = UnixListener::bind(&socket_path).unwrap();
        let host_task = tokio::spawn(async move {
            let (host, _) = host_listener.accept().await.unwrap();
            let (read, mut write) = host.into_split();
            let hello = format!(
                "{{\"connectionId\":\"one\",\"packageVersion\":\"{}\",\"schema\":\"pi-workflows.client.v1\",\"type\":\"hello\"}}\n",
                env!("CARGO_PKG_VERSION")
            );
            write.write_all(hello.as_bytes()).await.unwrap();
            let mut lines = BufReader::new(read).lines();
            lines.next_line().await.unwrap().unwrap()
        });
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = tcp.local_addr().unwrap();
        let relay_task = tokio::spawn(serve_on(tcp, socket_path));
        let (mut websocket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let hello = websocket.next().await.unwrap().unwrap();
        assert!(hello.into_text().unwrap().contains("\"type\":\"hello\""));
        let request = "{\"clientId\":\"client\",\"idempotencyKey\":\"key\",\"operation\":\"host.status\",\"payload\":{},\"requestId\":\"request\",\"schema\":\"pi-workflows.client.v1\",\"type\":\"request\"}";
        websocket
            .send(Message::Text(request.to_string().into()))
            .await
            .unwrap();
        assert_eq!(host_task.await.unwrap(), request);
        websocket.close(None).await.unwrap();
        relay_task.abort();
    }
}
