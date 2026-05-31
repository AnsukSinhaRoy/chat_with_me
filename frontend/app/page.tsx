import "./globals.css";
import Chat from "../components/Chat";
import BackendStatus from "../components/BackendStatus";

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
            <div className="brand-logo-wrap">
              <span className="brand-logo">
                <span className="brand-logo-core">A</span>
                <span className="brand-logo-orbit brand-logo-orbit-one" />
                <span className="brand-logo-orbit brand-logo-orbit-two" />
              </span>
              <BackendStatus />
            </div>
            <div className="brand-copy">
              <div className="brand-title">Talk to Ansuk</div>
              <div className="brand-subtitle">
                Applied ML • Deep RL • Fintech
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="content">
        <Chat />
      </div>
    </main>
  );
}
