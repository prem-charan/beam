import { useEffect, useRef, useState } from "react";
import type { Message } from "@beam/shared";

// Persisted per-tab (not per-browser) so a reconnect after a brief drop
// (phone locked, app backgrounded, switched to another app and back) can
// claim the same identity the server still remembers - but a brand new tab
// still starts fresh rather than silently inheriting someone else's session.
const CLIENT_ID_KEY = "beam_client_id";

// How long to wait before trying again after a dropped connection. Doesn't
// grow forever - at some point a human is looking at a broken page, and a
// few seconds between attempts is as patient as that should get.
const RECONNECT_DELAY_MS = 2000;

export function useWebSocket() {
    const socketRef = useRef<WebSocket | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [clientId, setclientId] = useState<string | null>(null);
    const unmountedRef = useRef(false);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        unmountedRef.current = false;

        function connect() {
            const baseUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:3000";
            const storedClientId = sessionStorage.getItem(CLIENT_ID_KEY);
            const url = storedClientId
                ? `${baseUrl}?clientId=${encodeURIComponent(storedClientId)}`
                : baseUrl;

            const socket = new WebSocket(url);
            socketRef.current = socket;

            socket.onopen = () => {
                console.log("websocket connected");
            };
            socket.onmessage = (event) => {
                const message: Message = JSON.parse(event.data);
                console.log("server: ", message);

                if (message.type === "CONNECTED" && message.clientId) {
                    setclientId(message.clientId);
                    sessionStorage.setItem(CLIENT_ID_KEY, message.clientId);
                }
                setMessages((prev) => [...prev, message]);
            };
            socket.onclose = () => {
                console.log("websocket disconnected");
                if (unmountedRef.current) {
                    return;
                }
                reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
            };
            socket.onerror = (error) => {
                console.log("websocket error: ", error);
            };
        }

        connect();

        return () => {
            unmountedRef.current = true;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
            }
            socketRef.current?.close();
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
