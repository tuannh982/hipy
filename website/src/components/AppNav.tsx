import { NavLink } from "react-router-dom";

export function AppNav() {
  return (
    <header className="app-header">
      <div className="brand">
        <img className="brand-mark" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        <h1>HIPY</h1>
      </div>
      <nav className="nav-links" aria-label="Main">
        <NavLink className="nav-link" to="/home">Home</NavLink>
        <NavLink className="nav-link" to="/playground">Playground</NavLink>
        <NavLink className="nav-link" to="/learn">Learn</NavLink>
        <NavLink className="nav-link" to="/references">References</NavLink>
      </nav>
      <a
        className="repo-link"
        href="https://github.com/tuannh982/hipy"
        target="_blank"
        rel="noopener noreferrer"
        title="View the HIPY source on GitHub"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38l-.01-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.89.87 2.35.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.37.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
          />
        </svg>
        <span>hipy on GitHub</span>
      </a>
    </header>
  );
}
