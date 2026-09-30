import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";

function App() {
    const { send, messages, cliendId } = useWebSocket();
    const [roomId, setRoomId] = useState("");
    const [roomCount, setRoomCount] = useState(0);
    const [inRoom, setInRoom] = useState(false);
    const [cameraEnabled, setCameraEnabled] = useState(false);
    const [micEnabled, setMicEnabled] = useState(false);
    const peerConnections = useRef(new Map<string, RTCPeerConnection>());
    const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
    const localStream = useRef<MediaStream | null>(null);
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

    // each effect below tracks how many messages (from the shared queue) it has
    // already processed, so a batch of several messages arriving together never
    // causes one of them to be silently skipped.
    const roomStatusProcessed = useRef(0);
    const leftProcessed = useRef(0);
    const viewerJoinedProcessed = useRef(0);
    const offerProcessed = useRef(0);
    const answerProcessed = useRef(0);
    const iceCandidateProcessed = useRef(0);

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

    async function toggleCamera() {
        const existingTrack = localStream.current?.getVideoTracks()[0];

        if (existingTrack) {
            existingTrack.stop();
            localStream.current!.removeTrack(existingTrack);

            peerConnections.current.forEach((peerConnection) => {
                const sender = peerConnection
                    .getSenders()
                    .find((s) => s.track === existingTrack);
                if (sender) {
                    peerConnection.removeTrack(sender);
                }
            });

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream.current;
            }

            setCameraEnabled(false);
            console.log("camera turned off and released");
            return;
        }

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: true,
            });
            const [videoTrack] = newStream.getVideoTracks();

            if (!localStream.current) {
                localStream.current = new MediaStream();
            }
            localStream.current.addTrack(videoTrack);

            if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream.current;
                localVideoRef.current.play().catch((error) => {
                    console.error("Local video play() blocked:", error);
                });
            }

            peerConnections.current.forEach((peerConnection) => {
                peerConnection.addTrack(videoTrack, localStream.current!);
            });

            setCameraEnabled(true);
            console.log("camera enabled for the first time");
        } catch (error) {
            console.error("Failed to enable camera:", error);
        }
    }

    async function toggleMic() {
        const existingTrack = localStream.current?.getAudioTracks()[0];

        if (existingTrack) {
            existingTrack.stop();
            localStream.current!.removeTrack(existingTrack);

            peerConnections.current.forEach((peerConnection) => {
                const sender = peerConnection
                    .getSenders()
                    .find((s) => s.track === existingTrack);
                if (sender) {
                    peerConnection.removeTrack(sender);
                }
            });

            setMicEnabled(false);
            console.log("mic turned off and released");
            return;
        }

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            const [audioTrack] = newStream.getAudioTracks();

            if (!localStream.current) {
                localStream.current = new MediaStream();
            }
            localStream.current.addTrack(audioTrack);

            peerConnections.current.forEach((peerConnection) => {
                peerConnection.addTrack(audioTrack, localStream.current!);
            });

            setMicEnabled(true);
            console.log("mic enabled for the first time");
        } catch (error) {
            console.error("Failed to enable mic:", error);
        }
    }

    function leaveRoom() {
        send({ type: "LEAVE_ROOM" });

        peerConnections.current.forEach((peerConnection) => {
            peerConnection.close();
        });
        peerConnections.current.clear();
        pendingCandidates.current.clear();
        if (localStream.current) {
            localStream.current.getTracks().forEach((track) => track.stop());
            localStream.current = null;
        }
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = null;
        }
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }

        setRoomId("");
        setRoomCount(0);
        setInRoom(false);
        setCameraEnabled(false);
        setMicEnabled(false);
        console.log("left room, cleaned up all connections and media");
    }

    useEffect(() => {
        window.addEventListener("pagehide", leaveRoom);
        return () => {
            window.removeEventListener("pagehide", leaveRoom);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const newMessages = messages.slice(roomStatusProcessed.current);
        roomStatusProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type === "ROOM_CREATED" || message.type === "ROOM_JOINED") {
                queueMicrotask(() => setInRoom(true));
                continue;
            }

            if (message.type === "ROOM_COUNT" && typeof message.count === "number") {
                const count = message.count;
                queueMicrotask(() => setRoomCount(count));
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(leftProcessed.current);
        leftProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type === "HOST_LEFT") {
                console.log("host left the room, cleaning up");
                queueMicrotask(() => leaveRoom());
                continue;
            }

            if (message.type === "VIEWER_LEFT" && message.clientId) {
                const viewerClientId = message.clientId;
                console.log("viewer left:", viewerClientId);

                const peerConnection = peerConnections.current.get(viewerClientId);
                if (peerConnection) {
                    peerConnection.close();
                    peerConnections.current.delete(viewerClientId);
                }
                pendingCandidates.current.delete(viewerClientId);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(viewerJoinedProcessed.current);
        viewerJoinedProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "VIEWER_JOINED") {
                continue;
            }
            if (!message.clientId) {
                continue;
            }
            if (!cliendId) {
                continue;
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

            peerConnection.onnegotiationneeded = async () => {
                try {
                    console.log("negotiation needed for viewer:", viewerClientId);
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    send({
                        type: "OFFER",
                        targetClientId: viewerClientId,
                        offer: peerConnection.localDescription,
                    });
                    console.log("OFFER (re)sent to:", viewerClientId);
                } catch (error) {
                    console.error("HOST renegotiation failed:", error);
                }
            };

            if (localStream.current) {
                localStream.current.getTracks().forEach((track) => {
                    console.log(
                        "adding existing track to new viewer:",
                        track.kind,
                        track.readyState,
                        track.enabled,
                    );
                    peerConnection.addTrack(track, localStream.current!);
                });
            } else {
                console.log(
                    "no local media yet, viewer will wait until camera/mic is enabled",
                );
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, cliendId, send]);

    useEffect(() => {
        const newMessages = messages.slice(offerProcessed.current);
        offerProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "OFFER") {
                continue;
            }
            if (!message.offer) {
                continue;
            }
            if (!message.targetClientId) {
                continue;
            }
            if (!message.senderClientId) {
                continue;
            }

            const hostClientId = message.senderClientId;
            const offer = message.offer;
            const existingConnection = peerConnections.current.get(hostClientId);
            const peerConnection =
                existingConnection ??
                new RTCPeerConnection({
                    iceServers: [
                        {
                            urls: "stun:stun.l.google.com:19302",
                        },
                    ],
                });

            if (!existingConnection) {
                console.log(
                    "OFFER received from host (new connection):",
                    hostClientId,
                );
                peerConnections.current.set(hostClientId, peerConnection);

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
                    const [remoteStream] = event.streams;
                    if (
                        remoteVideoRef.current &&
                        remoteVideoRef.current.srcObject !== remoteStream
                    ) {
                        remoteVideoRef.current.srcObject = remoteStream;
                        remoteVideoRef.current.play().catch((error) => {
                            console.error(
                                "VIEWER remote video play() blocked:",
                                error,
                            );
                        });
                    }

                    remoteStream.onremovetrack = () => {
                        console.log(
                            "remote track removed, remaining video tracks:",
                            remoteStream.getVideoTracks().length,
                        );
                        if (
                            remoteStream.getVideoTracks().length === 0 &&
                            remoteVideoRef.current
                        ) {
                            remoteVideoRef.current.srcObject = null;
                        }
                    };
                };
            } else {
                console.log(
                    "OFFER received from host (renegotiation):",
                    hostClientId,
                );
            }

            (async () => {
                try {
                    await peerConnection.setRemoteDescription(offer);
                    console.log("VIEWER remote description set");
                    const pending =
                        pendingCandidates.current.get(hostClientId) ?? [];

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
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, cliendId, send]);

    useEffect(() => {
        const newMessages = messages.slice(answerProcessed.current);
        answerProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "ANSWER") {
                continue;
            }
            if (!message.answer) {
                continue;
            }
            if (!message.senderClientId) {
                continue;
            }

            const viewerClientId = message.senderClientId;
            const answer = message.answer;
            console.log("ANSWER received from viewer:", viewerClientId);
            const peerConnection = peerConnections.current.get(viewerClientId);
            if (!peerConnection) {
                console.log("No peer connection found for:", viewerClientId);
                continue;
            }

            (async () => {
                try {
                    await peerConnection.setRemoteDescription(answer);

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
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(iceCandidateProcessed.current);
        iceCandidateProcessed.current = messages.length;

        for (const message of newMessages) {
            if (message.type !== "ICE_CANDIDATE") {
                continue;
            }
            if (!message.senderClientId) {
                continue;
            }
            if (!message.candidate) {
                continue;
            }

            const remoteClientId = message.senderClientId;
            const candidate = message.candidate;
            const peerConnection = peerConnections.current.get(remoteClientId);

            if (!peerConnection) {
                console.log("No peer connection found for:", remoteClientId);
                continue;
            }

            (async () => {
                try {
                    if (!peerConnection.remoteDescription) {
                        console.log(
                            "Remote description not ready. Queueing ICE candidate from:",
                            remoteClientId,
                        );

                        const candidates =
                            pendingCandidates.current.get(remoteClientId) ?? [];

                        candidates.push(candidate);

                        pendingCandidates.current.set(remoteClientId, candidates);

                        return;
                    }

                    await peerConnection.addIceCandidate(candidate);

                    console.log("ICE candidate added from:", remoteClientId);
                } catch (error) {
                    console.error("Failed to add ICE candidate:", error);
                }
            })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

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

            <button onClick={leaveRoom}>Leave Room</button>

            <button onClick={toggleCamera}>
                Camera: {cameraEnabled ? "On" : "Off"}
            </button>

            <button onClick={toggleMic}>Mic: {micEnabled ? "On" : "Off"}</button>

            {inRoom && <p>People in room: {roomCount}</p>}

            <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
                <div>
                    <h3>Your camera (local preview)</h3>
                    <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                            width: "320px",
                            background: "#000",
                            transform: "scaleX(-1)",
                        }}
                    />
                </div>

                <div>
                    <h3>Remote stream (viewer side)</h3>
                    <video
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                        style={{ width: "320px", background: "#000" }}
                    />
                </div>
            </div>

            <h2>Server Message</h2>

            {messages.length > 0 && (
                <pre>{JSON.stringify(messages[messages.length - 1], null, 2)}</pre>
            )}
        </div>
    );
}

export default App;
