// A minimal LSP server over stdio for tests. It speaks Content-Length framing and answers
// initialize, didOpen/didChange (publishing a diagnostic when the text contains "ERROR"),
// definition, rename, shutdown and exit.
//
// Environment switches:
//   FAKE_LSP_PID_FILE  write this process's pid to the file on start
//   FAKE_LSP_SILENT=1  never publish diagnostics (used for timeout tests)
//   FAKE_LSP_CRASH=once    exit on the first didOpen, only while FAKE_LSP_MARKER is absent
//   FAKE_LSP_CRASH=always  exit on every didOpen
//   FAKE_LSP_SPLIT=1   publish an empty set first (the syntax pass), then the errors after
//                      FAKE_LSP_SPLIT_DELAY_MS (default 300), as typescript-language-server can
//   FAKE_LSP_SILENT_AFTER_FIRST=1  publish for the first document only, then stay silent
import { existsSync, writeFileSync } from "node:fs";

if (process.env.FAKE_LSP_PID_FILE) {
  writeFileSync(process.env.FAKE_LSP_PID_FILE, String(process.pid));
}

let silent = process.env.FAKE_LSP_SILENT === "1";
const split = process.env.FAKE_LSP_SPLIT === "1";
const splitDelayMs = Number(process.env.FAKE_LSP_SPLIT_DELAY_MS ?? 300);
const silentAfterFirst = process.env.FAKE_LSP_SILENT_AFTER_FIRST === "1";
const crashMode = process.env.FAKE_LSP_CRASH ?? "";
const marker = process.env.FAKE_LSP_MARKER ?? "";

function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, code, message) {
  send({ id, error: { code, message } });
}

function publish(uri, version, text) {
  const diagnostics = text.includes("ERROR")
    ? [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          severity: 1,
          source: "fake",
          code: 1,
          message: "fake error",
        },
      ]
    : [];
  send({
    method: "textDocument/publishDiagnostics",
    params: { uri, version, diagnostics },
  });
}

function handleNotification(method, params) {
  if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    if (method === "textDocument/didOpen" && crashMode === "always") process.exit(3);
    if (method === "textDocument/didOpen" && crashMode === "once" && !existsSync(marker)) {
      writeFileSync(marker, "crashed");
      process.exit(3);
    }
    if (silent) return;
    const doc = params.textDocument;
    const text =
      method === "textDocument/didOpen"
        ? doc.text
        : params.contentChanges[params.contentChanges.length - 1].text;
    if (split && text.includes("ERROR")) {
      send({
        method: "textDocument/publishDiagnostics",
        params: { uri: doc.uri, version: doc.version, diagnostics: [] },
      });
      setTimeout(() => publish(doc.uri, doc.version, text), splitDelayMs);
      return;
    }
    publish(doc.uri, doc.version, text);
    if (silentAfterFirst) silent = true;
  }
}

function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      respond(id, { capabilities: {} });
      return;
    case "shutdown":
      respond(id, null);
      return;
    case "textDocument/definition":
      respond(id, {
        uri: params.textDocument.uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      });
      return;
    case "textDocument/rename":
      respond(id, {
        changes: {
          [params.textDocument.uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: params.newName,
            },
          ],
        },
      });
      return;
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length: (\d+)/i.exec(header);
    if (match === null) {
      process.exit(2);
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);

    if (message.method === "exit") process.exit(0);
    if (message.id !== undefined && message.method !== undefined) {
      handleRequest(message.id, message.method, message.params);
    } else if (message.method !== undefined) {
      handleNotification(message.method, message.params);
    }
  }
});
