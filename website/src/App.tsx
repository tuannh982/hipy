import { Navigate, Route, Routes } from "react-router-dom";
import { AppNav } from "./components/AppNav";
import { HomePage } from "./routes/HomePage";
import { LessonPage } from "./routes/LessonPage";
import { PlaygroundPage } from "./routes/PlaygroundPage";
import { ReferencesPage } from "./routes/ReferencesPage";
import { TrackPage } from "./routes/TrackPage";

export function App() {
  return (
    <div className="app-shell">
      <AppNav />
      <Routes>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<HomePage />} />
        <Route path="/playground" element={<PlaygroundPage />} />
        <Route path="/learn" element={<TrackPage />} />
        <Route path="/learn/:trackId" element={<TrackPage />} />
        <Route path="/learn/:trackId/:lessonId" element={<LessonPage />} />
        <Route path="/references" element={<ReferencesPage />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </div>
  );
}
