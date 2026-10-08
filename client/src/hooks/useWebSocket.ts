import { useEffect, useRef, useState } from "react";
import type { Message } from "@beam/shared";

export function useWebSocket() {
    const socketRef = useRef<WebSocket | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [clientId, setclientId] = useState<string | null>(null);

    useEffect(() => {
        const socket = new WebSocket(
            import.meta.env.VITE_WS_URL ?? "ws://localhost:3000",
        );
        socketRef.current = socket;
        socket.onopen = () => {
            console.log("websocket connected");
        };
        socket.onmessage = (event) => {
            const message: Message = JSON.parse(event.data);
            console.log("server: ", message);

            if (message.type === "CONNECTED" && message.clientId) {
                setclientId(message.clientId);
            }
            setMessages((prev) => [...prev, message]);
        };
        socket.onclose = () => {
            console.log("websocket disconnected");
        };
        socket.onerror = (error) => {
            console.log("websocket error: ", error);
        };
        return () => {
            socket.close();
        };
    }, []);
    function send(message: Message) {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            console.error("websocket is not connected");
            return;
        }
        socket.send(JSON.stringify(message));
    }
    return {
        send,
        messages,
        clientId,
    };
}
