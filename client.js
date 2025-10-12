// client-cli.js
const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:8080/ws");

ws.on("open", () => console.log("connected"));
ws.on("message", (msg) => console.log("received:", msg.toString()));
ws.on("close", () => console.log("disconnected"));
ws.on("error", (e) => console.error("error:", e.message));
