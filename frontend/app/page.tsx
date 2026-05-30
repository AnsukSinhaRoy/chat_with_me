import "./globals.css";
import Chat from "../components/Chat";
import BackendStatus from "../components/BackendStatus";
import ThemeToggle from "../components/ThemeToggle";

export default function Page() {
  return (
    <main className="app">
      <div className="ambient-stage" aria-hidden="true">
        <div className="ambient-orb ambient-orb-one" />
        <div className="ambient-orb ambient-orb-two" />
        <div className="ambient-orb ambient-orb-three" />
        <div className="ambient-grid" />
        <div className="ambient-vignette" />
      </div>

      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <BackendStatus />
            <div>
              <div className="brand-title">Talk to Ansuk</div>
              <div className="brand-subtitle">
                Applied ML • Deep RL • Fintech
              </div>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="content">
        <Chat />
      </div>
    </main>
  );
}
