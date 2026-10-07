import { useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import "./App.css";

type View = "landing" | "waiting" | "in-room";

function roomCodeFromPath(): string {
    const match = window.location.pathname.match(/^\/r\/([A-Za-z0-9]{6})$/);
    return match ? match[1].toUpperCase() : "";
}

// Accepts either a bare code ("AB3XQ9") or a full pasted link
// ("http://host/r/AB3XQ9") and extracts just the code. Specifically looks
// for the /r/<code> pattern rather than "the first 6-character run of
// letters/digits", since a full URL can easily contain an unrelated
// 6-character run (e.g. "localhost" would otherwise wrongly match "LOCALH").
function extractRoomCode(input: string): string {
    const trimmed = input.trim();
    const pathMatch = trimmed.match(/\/r\/([A-Za-z0-9]{6})/);
    return (pathMatch ? pathMatch[1] : trimmed).toUpperCase();
}

function App() {
    const { send, messages, clientId } = useWebSocket();

    const [view, setView] = useState<View>("landing");
    const [displayName, setDisplayName] = useState("");
    const [joinCodeInput, setJoinCodeInput] = useState(() => roomCodeFromPath());
    const [roomId, setRoomId] = useState("");
    const [isHost, setIsHost] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [linkCopied, setLinkCopied] = useState(false);

    const [roomCount, setRoomCount] = useState(0);
    const [cameraEnabled, setCameraEnabled] = useState(false);
    const [micEnabled, setMicEnabled] = useState(false);
    const [mediaError, setMediaError] = useState<string | null>(null);
    const [pendingRequests, setPendingRequests] = useState<Map<string, string>>(
        new Map(),
    );
    const [participantNames, setParticipantNames] = useState<
        Map<string, string>
    >(new Map());

    const peerConnections = useRef(new Map<string, RTCPeerConnection>());
    const pendingCandidates = useRef(new Map<string, RTCIceCandidateInit[]>());
    const localStream = useRef<MediaStream | null>(null);
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const [participants, setParticipants] = useState<
        Map<string, MediaStream | null>
    >(new Map());
    const videoElements = useRef(new Map<string, HTMLVideoElement>());
    const micMeterRef = useRef<HTMLDivElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const meterFrameRef = useRef<number | null>(null);

    // each effect below tracks how many messages (from the shared queue) it has
    // already processed, so a batch of several messages arriving together never
    // causes one of them to be silently skipped.
    const roomStatusProcessed = useRef(0);
    const leftProcessed = useRef(0);
    const viewerJoinedProcessed = useRef(0);
    const offerProcessed = useRef(0);
    const answerProcessed = useRef(0);
    const iceCandidateProcessed = useRef(0);
    const joinRequestProcessed = useRef(0);

    function createRoom() {
        if (!displayName.trim()) {
            setFormError("Enter your name first");
            return;
        }
        setFormError(null);
        send({ type: "CREATE_ROOM", displayName: displayName.trim() });
    }

    function requestToJoin() {
        if (!displayName.trim()) {
            setFormError("Enter your name first");
            return;
        }
        if (!joinCodeInput.trim()) {
            setFormError("Enter a room code or link");
            return;
        }
        setFormError(null);
        send({
            type: "JOIN_REQUEST",
            roomId: extractRoomCode(joinCodeInput),
            displayName: displayName.trim(),
        });
        setView("waiting");
    }

    function respondToJoinRequest(targetClientId: string, approved: boolean) {
        send({ type: "JOIN_RESPONSE", targetClientId, approved });
        setPendingRequests((prev) => {
            const next = new Map(prev);
            next.delete(targetClientId);
            return next;
        });
    }

    function describeMediaError(error: unknown): string {
        if (error instanceof DOMException) {
            return `${error.name}: ${error.message}`;
        }
        return String(error);
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
            setMediaError(null);
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
            setMediaError(`Camera failed: ${describeMediaError(error)}`);
        }
    }

    // Shows a live bar that grows with how loud your mic currently is — the
    // only way to actually confirm a mic is picking up sound, since (unlike
    // camera) there's nothing to visually show otherwise. AnalyserNode reads
    // the audio stream's volume many times per second; we deliberately do
    // NOT put that value in React state (a 60-times-a-second setState would
    // cause a re-render every frame) and instead set the bar's width
    // directly via a ref, bypassing React entirely for this one fast-moving
    // value.
    function startMicMeter(audioTrack: MediaStreamTrack) {
        const audioContext = new AudioContext();
        if (audioContext.state === "suspended") {
            audioContext.resume().catch((error) => {
                console.error("AudioContext resume() failed:", error);
            });
        }
        const source = audioContext.createMediaStreamSource(
            new MediaStream([audioTrack]),
        );
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        audioContextRef.current = audioContext;

        const data = new Uint8Array(analyser.frequencyBinCount);

        function tick() {
            analyser.getByteFrequencyData(data);
            const average =
                data.reduce((sum, value) => sum + value, 0) / data.length / 255;
            if (micMeterRef.current) {
                micMeterRef.current.style.transform = `scaleX(${Math.min(1, average * 3)})`;
            }
            meterFrameRef.current = requestAnimationFrame(tick);
        }
        tick();
    }

    function stopMicMeter() {
        if (meterFrameRef.current !== null) {
            cancelAnimationFrame(meterFrameRef.current);
            meterFrameRef.current = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        if (micMeterRef.current) {
            micMeterRef.current.style.transform = "scaleX(0)";
        }
    }

    async function toggleMic() {
        console.log("toggleMic clicked");
        const existingTrack = localStream.current?.getAudioTracks()[0];

        if (existingTrack) {
            existingTrack.stop();
            localStream.current!.removeTrack(existingTrack);
            stopMicMeter();

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
            setMediaError(null);
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            const [audioTrack] = newStream.getAudioTracks();

            if (!localStream.current) {
                localStream.current = new MediaStream();
            }
            localStream.current.addTrack(audioTrack);
            startMicMeter(audioTrack);

            peerConnections.current.forEach((peerConnection) => {
                peerConnection.addTrack(audioTrack, localStream.current!);
            });

            setMicEnabled(true);
            console.log("mic enabled for the first time");
        } catch (error) {
            console.error("Failed to enable mic:", error);
            setMediaError(`Microphone failed: ${describeMediaError(error)}`);
        }
    }

    function leaveRoom() {
        send({ type: "LEAVE_ROOM" });

        peerConnections.current.forEach((peerConnection) => {
            peerConnection.close();
        });
        peerConnections.current.clear();
        pendingCandidates.current.clear();
        stopMicMeter();
        if (localStream.current) {
            localStream.current.getTracks().forEach((track) => track.stop());
            localStream.current = null;
        }
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = null;
        }

        setRoomId("");
        setRoomCount(0);
        setCameraEnabled(false);
        setMicEnabled(false);
        setParticipants(new Map());
        setParticipantNames(new Map());
        setPendingRequests(new Map());
        setIsHost(false);
        setView("landing");
        window.history.pushState({}, "", "/");
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
            if (message.type === "ROOM_CREATED" && message.roomId) {
                const newRoomId = message.roomId;
                queueMicrotask(() => {
                    setRoomId(newRoomId);
                    setIsHost(true);
                    setView("in-room");
                });
                window.history.pushState({}, "", `/r/${newRoomId}`);
                continue;
            }

            if (message.type === "ROOM_JOINED" && message.roomId) {
                const newRoomId = message.roomId;
                const roster = message.participants ?? [];
                queueMicrotask(() => {
                    setRoomId(newRoomId);
                    setIsHost(false);
                    setView("in-room");
                    setParticipantNames((prev) => {
                        const next = new Map(prev);
                        roster.forEach((p) => next.set(p.clientId, p.displayName));
                        return next;
                    });
                });
                window.history.pushState({}, "", `/r/${newRoomId}`);
                continue;
            }

            if (message.type === "JOIN_DENIED") {
                queueMicrotask(() => {
                    setView("landing");
                    setFormError("The host denied your request to join.");
                });
                continue;
            }

            if (message.type === "ERROR" && message.message) {
                const errorText = message.message;
                queueMicrotask(() => {
                    setFormError(errorText);
                    setView((current) => (current === "waiting" ? "landing" : current));
                });
                continue;
            }

            if (
                message.type === "ROOM_COUNT" &&
                typeof message.count === "number"
            ) {
                const count = message.count;
                queueMicrotask(() => setRoomCount(count));
            }
        }
    }, [messages]);

    useEffect(() => {
        const newMessages = messages.slice(joinRequestProcessed.current);
        joinRequestProcessed.current = messages.length;

        for (const message of newMessages) {
            if (
                message.type === "JOIN_REQUEST" &&
                message.clientId &&
                message.displayName
            ) {
                const requesterId = message.clientId;
                const requesterName = message.displayName;
                queueMicrotask(() => {
                    setPendingRequests((prev) => {
                        const next = new Map(prev);
                        next.set(requesterId, requesterName);
                        return next;
                    });
                });
                continue;
            }

            if (message.type === "JOIN_CANCELLED" && message.clientId) {
                const cancelledId = message.clientId;
                queueMicrotask(() => {
                    setPendingRequests((prev) => {
                        const next = new Map(prev);
                        next.delete(cancelledId);
                        return next;
                    });
                });
            }
        }
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

                const peerConnection =
                    peerConnections.current.get(viewerClientId);
                if (peerConnection) {
                    peerConnection.close();
                    peerConnections.current.delete(viewerClientId);
                }
                pendingCandidates.current.delete(viewerClientId);

                queueMicrotask(() => {
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        next.delete(viewerClientId);
                        return next;
                    });
                    setParticipantNames((prev) => {
                        const next = new Map(prev);
                        next.delete(viewerClientId);
                        return next;
                    });
                });
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
            if (!clientId) {
                continue;
            }

            const remoteClientId = message.clientId;
            const remoteDisplayName = message.displayName ?? "Guest";
            queueMicrotask(() => {
                setParticipantNames((prev) => {
                    const next = new Map(prev);
                    next.set(remoteClientId, remoteDisplayName);
                    return next;
                });
            });

            console.log(
                "new participant joined, creating peerconnection:",
                remoteClientId,
            );
            const peerConnection = new RTCPeerConnection({
                iceServers: [
                    {
                        urls: "stun:stun.l.google.com:19302",
                    },
                ],
            });

            peerConnections.current.set(remoteClientId, peerConnection);
            console.log("peerConnection created:", peerConnection);

            queueMicrotask(() => {
                setParticipants((prev) => {
                    const next = new Map(prev);
                    next.set(remoteClientId, null);
                    return next;
                });
            });

            peerConnection.onicecandidate = (event) => {
                console.log("ICE event:", event);
                if (!event.candidate) {
                    console.log("ICE gathering complete");
                    return;
                }
                send({
                    type: "ICE_CANDIDATE",
                    targetClientId: remoteClientId,
                    candidate: event.candidate,
                });
                console.log("ICE candidate sent to:", remoteClientId);
            };

            peerConnection.onicegatheringstatechange = () => {
                console.log(
                    "ICE gathering state:",
                    peerConnection.iceGatheringState,
                );
            };

            peerConnection.oniceconnectionstatechange = () => {
                console.log(
                    "ICE connection state:",
                    peerConnection.iceConnectionState,
                );
            };

            peerConnection.onconnectionstatechange = () => {
                console.log(
                    "peer connection state:",
                    peerConnection.connectionState,
                );
            };
            peerConnection.onicecandidateerror = (event) => {
                console.error("ICE candidate error:", event);
            };

            peerConnection.ontrack = (event) => {
                console.log("received remote track:", event.track);
                const [remoteStream] = event.streams;
                setParticipants((prev) => {
                    const next = new Map(prev);
                    next.set(remoteClientId, remoteStream);
                    return next;
                });

                remoteStream.onremovetrack = () => {
                    console.log(
                        "track removed from stream for:",
                        remoteClientId,
                        "remaining video tracks:",
                        remoteStream.getVideoTracks().length,
                    );
                    const el = videoElements.current.get(remoteClientId);
                    if (el && remoteStream.getVideoTracks().length === 0) {
                        el.load();
                    }
                };
            };

            const negotiate = async () => {
                try {
                    console.log("negotiating with:", remoteClientId);
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    send({
                        type: "OFFER",
                        targetClientId: remoteClientId,
                        offer: peerConnection.localDescription!,
                    });
                    console.log("OFFER (re)sent to:", remoteClientId);
                } catch (error) {
                    console.error("negotiation failed:", error);
                }
            };
            peerConnection.onnegotiationneeded = negotiate;

            if (localStream.current) {
                localStream.current.getTracks().forEach((track) => {
                    console.log(
                        "adding existing track for new participant:",
                        track.kind,
                        track.readyState,
                        track.enabled,
                    );
                    peerConnection.addTrack(track, localStream.current!);
                });
                // addTrack above triggers onnegotiationneeded automatically
            } else {
                console.log(
                    "no local media yet, negotiating an empty connection so the other side can add their own media later",
                );
                negotiate();
            }
        }
    }, [messages, clientId, send]);

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

            const remoteClientId = message.senderClientId;
            const offer = message.offer;
            const existingConnection =
                peerConnections.current.get(remoteClientId);
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
                    "OFFER received (new connection) from:",
                    remoteClientId,
                );
                peerConnections.current.set(remoteClientId, peerConnection);

                queueMicrotask(() => {
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        next.set(remoteClientId, null);
                        return next;
                    });
                });

                peerConnection.onicecandidate = (event) => {
                    console.log("ICE event:", event);
                    if (!event.candidate) {
                        console.log("ICE gathering complete");
                        return;
                    }

                    send({
                        type: "ICE_CANDIDATE",
                        targetClientId: remoteClientId,
                        candidate: event.candidate,
                    });
                    console.log("ICE candidate sent to:", remoteClientId);
                };

                peerConnection.onicegatheringstatechange = () => {
                    console.log(
                        "ICE gathering state:",
                        peerConnection.iceGatheringState,
                    );
                };

                peerConnection.oniceconnectionstatechange = () => {
                    console.log(
                        "ICE connection state:",
                        peerConnection.iceConnectionState,
                    );
                };

                peerConnection.onconnectionstatechange = () => {
                    console.log(
                        "peer connection state:",
                        peerConnection.connectionState,
                    );
                };

                peerConnection.onicecandidateerror = (event) => {
                    console.error("ICE candidate error:", event);
                };

                peerConnection.onnegotiationneeded = async () => {
                    try {
                        console.log("negotiating with:", remoteClientId);
                        const newOffer = await peerConnection.createOffer();
                        await peerConnection.setLocalDescription(newOffer);
                        send({
                            type: "OFFER",
                            targetClientId: remoteClientId,
                            offer: peerConnection.localDescription!,
                        });
                        console.log("OFFER (re)sent to:", remoteClientId);
                    } catch (error) {
                        console.error("negotiation failed:", error);
                    }
                };

                peerConnection.ontrack = (event) => {
                    console.log("received remote track:", event.track);
                    const [remoteStream] = event.streams;
                    setParticipants((prev) => {
                        const next = new Map(prev);
                        next.set(remoteClientId, remoteStream);
                        return next;
                    });

                    remoteStream.onremovetrack = () => {
                        console.log(
                            "track removed from stream for:",
                            remoteClientId,
                            "remaining video tracks:",
                            remoteStream.getVideoTracks().length,
                        );
                        const el = videoElements.current.get(remoteClientId);
                        if (el && remoteStream.getVideoTracks().length === 0) {
                            el.load();
                        }
                    };
                };
            } else {
                console.log(
                    "OFFER received (renegotiation) from:",
                    remoteClientId,
                );
            }

            (async () => {
                try {
                    await peerConnection.setRemoteDescription(offer);
                    console.log("remote description set");
                    const pending =
                        pendingCandidates.current.get(remoteClientId) ?? [];

                    for (const candidate of pending) {
                        await peerConnection.addIceCandidate(candidate);
                        console.log(
                            "queued ICE candidate added from:",
                            remoteClientId,
                        );
                    }
                    pendingCandidates.current.delete(remoteClientId);

                    const answer = await peerConnection.createAnswer();

                    await peerConnection.setLocalDescription(answer);
                    console.log(
                        "local answer description set:",
                        peerConnection.localDescription,
                    );

                    send({
                        type: "ANSWER",
                        targetClientId: remoteClientId,
                        answer: peerConnection.localDescription!,
                    });

                    console.log("ANSWER sent to:", remoteClientId);
                } catch (error) {
                    console.error("failed to create answer:", error);
                }
            })();
        }
    }, [messages, clientId, send]);

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

            const remoteClientId = message.senderClientId;
            const answer = message.answer;
            console.log("ANSWER received from:", remoteClientId);
            const peerConnection = peerConnections.current.get(remoteClientId);
            if (!peerConnection) {
                console.log("No peer connection found for:", remoteClientId);
                continue;
            }

            (async () => {
                try {
                    await peerConnection.setRemoteDescription(answer);

                    console.log("remote answer description set");
                    const pending =
                        pendingCandidates.current.get(remoteClientId) ?? [];

                    for (const candidate of pending) {
                        await peerConnection.addIceCandidate(candidate);

                        console.log(
                            "queued ICE candidate added from:",
                            remoteClientId,
                        );
                    }

                    pendingCandidates.current.delete(remoteClientId);
                } catch (error) {
                    console.error("failed to set answer:", error);
                }
            })();
        }
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

                        pendingCandidates.current.set(
                            remoteClientId,
                            candidates,
                        );

                        return;
                    }

                    await peerConnection.addIceCandidate(candidate);

                    console.log("ICE candidate added from:", remoteClientId);
                } catch (error) {
                    console.error("Failed to add ICE candidate:", error);
                }
            })();
        }
    }, [messages]);

    const roomLink = roomId ? `${window.location.origin}/r/${roomId}` : "";

    function copyRoomLink() {
        navigator.clipboard.writeText(roomLink).then(() => {
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        });
    }

    if (view === "landing") {
        return (
            <div className="landing">
                <div className="landing-card">
                    <h1>Live Streaming App</h1>
                    <p className="subtitle">Start a room, or join one with a code</p>

                    <input
                        className="text-input"
                        type="text"
                        placeholder="Your name"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                    />

                    {formError && <p className="form-error">{formError}</p>}

                    <button className="btn btn-primary" onClick={createRoom}>
                        Create a room
                    </button>

                    <div className="divider">or</div>

                    <div className="join-row">
                        <input
                            className="text-input"
                            type="text"
                            placeholder="Room code or link"
                            value={joinCodeInput}
                            onChange={(event) =>
                                setJoinCodeInput(event.target.value)
                            }
                        />
                        <button className="btn btn-secondary" onClick={requestToJoin}>
                            Join
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (view === "waiting") {
        return (
            <div className="landing">
                <div className="landing-card">
                    <div className="spinner" />
                    <h2>Waiting for the host to let you in…</h2>
                    <button className="btn btn-secondary" onClick={leaveRoom}>
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="room">
            <header className="room-header">
                <div className="room-code-badge">
                    <span>{roomId}</span>
                    <button className="btn-link" onClick={copyRoomLink}>
                        {linkCopied ? "Copied!" : "Copy link"}
                    </button>
                </div>
                <div className="room-count">{roomCount} in room</div>
                <button className="btn btn-leave" onClick={leaveRoom}>
                    Leave
                </button>
            </header>

            {isHost && pendingRequests.size > 0 && (
                <div className="pending-panel">
                    {Array.from(pendingRequests.entries()).map(
                        ([requesterId, name]) => (
                            <div className="pending-request" key={requesterId}>
                                <span>
                                    <strong>{name}</strong> wants to join
                                </span>
                                <div className="pending-actions">
                                    <button
                                        className="btn btn-primary btn-small"
                                        onClick={() =>
                                            respondToJoinRequest(requesterId, true)
                                        }
                                    >
                                        Admit
                                    </button>
                                    <button
                                        className="btn btn-secondary btn-small"
                                        onClick={() =>
                                            respondToJoinRequest(requesterId, false)
                                        }
                                    >
                                        Deny
                                    </button>
                                </div>
                            </div>
                        ),
                    )}
                </div>
            )}

            <div
                className={
                    participants.size === 0 ? "tiles tiles-solo" : "tiles tiles-grid"
                }
            >
                <div className="tile">
                    <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className="tile-video tile-video-mirrored"
                    />
                    <span className="tile-label">You</span>
                    {micEnabled && (
                        <div className="mic-meter-track">
                            <div className="mic-meter-fill" ref={micMeterRef} />
                        </div>
                    )}
                </div>

                {Array.from(participants.entries()).map(([id, stream]) => (
                    <div className="tile" key={id}>
                        <video
                            ref={(el) => {
                                if (el) {
                                    videoElements.current.set(id, el);
                                    if (el.srcObject !== stream) {
                                        el.srcObject = stream;
                                        el.play().catch((error) => {
                                            console.error(
                                                "tile video play() blocked:",
                                                error,
                                            );
                                        });
                                    }
                                } else {
                                    videoElements.current.delete(id);
                                }
                            }}
                            autoPlay
                            playsInline
                            className="tile-video"
                        />
                        <span className="tile-label">
                            {participantNames.get(id) ?? "Guest"}
                        </span>
                    </div>
                ))}
            </div>

            {mediaError && <p className="form-error media-error">{mediaError}</p>}

            <div className="controls">
                <button
                    className={`btn-control ${cameraEnabled ? "on" : "off"}`}
                    onClick={toggleCamera}
                >
                    Camera {cameraEnabled ? "On" : "Off"}
                </button>
                <button
                    className={`btn-control ${micEnabled ? "on" : "off"}`}
                    onClick={toggleMic}
                >
                    Mic {micEnabled ? "On" : "Off"}
                </button>
            </div>
        </div>
    );
}

export default App;
