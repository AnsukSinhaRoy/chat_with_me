import "./globals.css";
import Chat from "../components/Chat";

export default function Page() {
  return (
    <main className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-dot" aria-hidden="true" />
            <div>
              <div className="brand-title">Talk to Ansuk</div>
              <div className="brand-subtitle">
                Applied ML • Deep RL • Fintech
              </div>
            </div>
          </div>
          <div className="status-pill">● Online</div>
        </div>
      </header>

      <div className="content">
        <Chat />
      </div>
    </main>
  );
}
