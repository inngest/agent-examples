import Chat from "./components/Chat";

export default function Home() {
  return (
    <main className="page">
      <header className="page-header">
        <h1>token-streaming-agent</h1>
        <p>LLM tokens streamed live over Inngest Realtime, from a Connect worker to this browser.</p>
      </header>
      <Chat />
    </main>
  );
}
