import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket"

function App() {
    const { send, message, cliendId } = useWebSocket();
    const [roomId, setRoomId] = useState("");
    const peerConnections = useRef(
        new Map<string, RTCPeerConnection>()
    );

    function createRoom() {
        if (!roomId.trim()) {
            return;
        }
        send({
            type: "CREATE_ROOM",
            roomId: roomId.trim(),
        });
    }
    
    function joinRoom() {
        if (!roomId.trim()) {
            return;
        }
        send({
            type: "JOIN_ROOM",
            roomId: roomId.trim(),
        });
    }

    useEffect(() => {
        if (message?.type !== "VIEWER_JOINED") {
            return;
        }
        if (!message.clientId) {
            return;
        }
        if (!cliendId) {
            return;
        }

        const viewerClientId = message.clientId;
        console.log("viewer joined, creating peerconnection:", viewerClientId);

        const peerConnection = new RTCPeerConnection();
        peerConnections.current.set(viewerClientId, peerConnection);
        console.log("peerConnection created: ", peerConnection);

        async function createOffer() {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            console.log("local description set: ", peerConnection.localDescription);

            send({
                type: "OFFER",
                targetClientId: viewerClientId,
                offer: peerConnection.localDescription,
            });
            console.log("OFFER sent to: ", viewerClientId);
        }
        createOffer();
    }, [message, cliendId, send]);

    useEffect(() => {
        if (message?.type !== "OFFER") {
            return;
        }
        if (!message.offer) {
            return;
        }
        if (!message.targetClientId) {
            return;
        }

        const hostClientId = message.senderClientId;
        console.log("OFFER received from host: ", hostClientId);

        const peerConnection = new RTCPeerConnection();
        peerConnections.current.set(hostClientId, peerConnection);
        console.log("viewer peerconnection created: ", peerConnection);

        async function createAnswer() {
            await peerConnection.setRemoteDescription(message.offer!);
            console.log("Remote description set");
            
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            console.log("local answer description set: ", peerConnection.localDescription);

            send({
                type: "ANSWER",
                targetClientId: hostClientId,
                answer: peerConnection.localDescription,
            });
            console.log("ANSWER sent to host: ", hostClientId);
        }
        createAnswer();
    }, [message,cliendId, send]);
    
    return (
        <div>
            <h1>Live streaming app</h1>

            <input
                type="text"
                placeholder="Enter room Id"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
            />
            
            <button onClick={createRoom}>
                Create Room
            </button>
            <button onClick={joinRoom}>
                Join Room
            </button>

            <h2>Server Message</h2>
            {message && (
                <pre>
                    {JSON.stringify(message, null, 2)}
                </pre>
            )}
        </div>
    );
}

export default App;
