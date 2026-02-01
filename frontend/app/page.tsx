import "./globals.css";
import Chat from "../components/Chat";

export default function Page() {
  return (
    <div className="container">
      <div className="header-card">
        <div className="header-left">
          <h3>🎙️ Talk to Ansuk</h3>
          <p>Applied ML • Deep RL • Reproducible experiments • <span style={{opacity:0.7}}>Tip: Chrome works best for voice.</span></p>
        </div>
        <div className="badge">● Online</div>
      </div>

      <Chat />
    </div>
  );
}
