import { createServer } from "node:http";
import { setupWebSocket } from "./websocket.js";

const PORT = process.env.PORT ?? 3000;

const server = createServer((req, res) => {
    res.writeHead(200, {
        "content-type": "text/plain",
    });
    res.end("streaming server is running");
});
setupWebSocket(server);

server.listen(PORT, () => {
    console.log(`server running on PORT: ${PORT}`);
});