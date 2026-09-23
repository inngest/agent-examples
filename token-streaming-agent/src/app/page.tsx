import Chat from "./components/Chat";

// Chat renders the whole shell (top bar, transcript, composer) so the New chat
// control and the composer can share its state without crossing components.
export default function Home() {
  return <Chat />;
}
