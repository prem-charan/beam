import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";

function App() {
    const { send, message, cliendId } = useWebSocket();
    const [roomId, setRoomId] = useState("");
    const peerConnections = useRef(new Map<string, RTCPeerConnection>());
    const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());

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
        const peerConnection = new RTCPeerConnection({
            iceServers: [
                {
                    urls: "stun:stun.l.google.com:19302",
                },
            ],
        });

        peerConnection.addTransceiver("video", {
            direction: "sendonly",
        });

        peerConnections.current.set(viewerClientId, peerConnection);
        console.log("peerConnection created:", peerConnection);

        peerConnection.onicecandidate = (event) => {
            console.log("HOST ICE event:", event);
            if (!event.candidate) {
                console.log("HOST ICE gathering complete");
                return;
            }
            send({
                type: "ICE_CANDIDATE",
                targetClientId: viewerClientId,
                candidate: event.candidate,
            });
            console.log("HOST ICE candidate sent to viewer:", viewerClientId);
        };

        peerConnection.onicegatheringstatechange = () => {
            console.log(
                "HOST ICE gathering state:",
                peerConnection.iceGatheringState,
            );
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log(
                "HOST ICE connection state:",
                peerConnection.iceConnectionState,
            );
        };

        peerConnection.onconnectionstatechange = () => {
            console.log(
                "HOST peer connection state:",
                peerConnection.connectionState,
            );
        };
        peerConnection.onicecandidateerror = (event) => {
            console.error("HOST ICE candidate error:", event);
        };

        async function createOffer() {
            try {
                const offer = await peerConnection.createOffer();

                await peerConnection.setLocalDescription(offer);
                console.log(
                    "HOST local description set:",
                    peerConnection.localDescription,
                );

                send({
                    type: "OFFER",
                    targetClientId: viewerClientId,
                    offer: peerConnection.localDescription,
                });
                console.log("HOST OFFER sent to:", viewerClientId);
            } catch (error) {
                console.error("HOST failed to create offer:", error);
            }
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
        if (!message.senderClientId) {
            return;
        }

        const hostClientId = message.senderClientId;
        console.log("OFFER received from host:", hostClientId);
        const peerConnection = new RTCPeerConnection({
            iceServers: [
                {
                    urls: "stun:stun.l.google.com:19302",
                },
            ],
        });

        peerConnections.current.set(hostClientId, peerConnection);
        console.log("viewer peerconnection created:", peerConnection);

        peerConnection.onicecandidate = (event) => {
            console.log("VIEWER ICE event:", event);
            if (!event.candidate) {
                console.log("VIEWER ICE gathering complete");
                return;
            }

            send({
                type: "ICE_CANDIDATE",
                targetClientId: hostClientId,
                candidate: event.candidate,
            });
            console.log("VIEWER ICE candidate sent to host:", hostClientId);
        };

        peerConnection.onicegatheringstatechange = () => {
            console.log(
                "VIEWER ICE gathering state:",
                peerConnection.iceGatheringState,
            );
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log(
                "VIEWER ICE connection state:",
                peerConnection.iceConnectionState,
            );
        };

        peerConnection.onconnectionstatechange = () => {
            console.log(
                "VIEWER peer connection state:",
                peerConnection.connectionState,
            );
        };

        peerConnection.onicecandidateerror = (event) => {
            console.error("VIEWER ICE candidate error:", event);
        };
        peerConnection.ontrack = (event) => {
            console.log("VIEWER received remote track:", event.track);
        };

        async function createAnswer() {
            try {
                await peerConnection.setRemoteDescription(message.offer!);
                console.log("VIEWER remote description set");
                const pending = pendingCandidates.current.get(hostClientId) ?? [];

                for (const candidate of pending) {
                    await peerConnection.addIceCandidate(candidate);
                    console.log(
                        "VIEWER queued ICE candidate added from:",
                        hostClientId,
                    );
                }
                pendingCandidates.current.delete(hostClientId);

                const answer = await peerConnection.createAnswer();

                await peerConnection.setLocalDescription(answer);
                console.log(
                    "VIEWER local answer description set:",
                    peerConnection.localDescription,
                );

                send({
                    type: "ANSWER",
                    targetClientId: hostClientId,
                    answer: peerConnection.localDescription,
                });

                console.log("VIEWER ANSWER sent to host:", hostClientId);
            } catch (error) {
                console.error("VIEWER failed to create answer:", error);
            }
        }
        createAnswer();
    }, [message, cliendId, send]);

    useEffect(() => {
        if (message?.type !== "ANSWER") {
            return;
        }
        if (!message.answer) {
            return;
        }
        if (!message.senderClientId) {
            return;
        }

        const viewerClientId = message.senderClientId;
        console.log("ANSWER received from viewer:", viewerClientId);
        const peerConnection = peerConnections.current.get(viewerClientId);
        if (!peerConnection) {
            console.log("No peer connection found for:", viewerClientId);

            return;
        }

        async function setAnswer() {
            try {
                await peerConnection.setRemoteDescription(message.answer!);

                console.log("HOST remote answer description set");
                const pending =
                    pendingCandidates.current.get(viewerClientId) ?? [];

                for (const candidate of pending) {
                    await peerConnection.addIceCandidate(candidate);

                    console.log(
                        "HOST queued ICE candidate added from:",
                        viewerClientId,
                    );
                }

                pendingCandidates.current.delete(viewerClientId);
            } catch (error) {
                console.error("HOST failed to set answer:", error);
            }
        }
        setAnswer();
    }, [message]);

    useEffect(() => {
        if (message?.type !== "ICE_CANDIDATE") {
            return;
        }

        if (!message.senderClientId) {
            return;
        }

        if (!message.candidate) {
            return;
        }

        const remoteClientId = message.senderClientId;

        const peerConnection = peerConnections.current.get(remoteClientId);

        if (!peerConnection) {
            console.log("No peer connection found for:", remoteClientId);
            return;
        }

        async function addCandidate() {
            try {
                if (!peerConnection.remoteDescription) {
                    console.log(
                        "Remote description not ready. Queueing ICE candidate from:",
                        remoteClientId,
                    );

                    const candidates =
                        pendingCandidates.current.get(remoteClientId) ?? [];

                    candidates.push(message.candidate!);

                    pendingCandidates.current.set(remoteClientId, candidates);

                    return;
                }

                await peerConnection.addIceCandidate(message.candidate!);

                console.log("ICE candidate added from:", remoteClientId);
            } catch (error) {
                console.error("Failed to add ICE candidate:", error);
            }
        }
        addCandidate();
    }, [message]);

    return (
        <div>
            <h1>Live streaming app</h1>

            <input
                type="text"
                placeholder="Enter room Id"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
            />

            <button onClick={createRoom}>Create Room</button>

            <button onClick={joinRoom}>Join Room</button>

            <h2>Server Message</h2>

            {message && <pre>{JSON.stringify(message, null, 2)}</pre>}
        </div>
    );
}

export default App;
