import { Link } from "react-router-dom";
import { ForgeLogo } from "./ForgeLogo";

/**
 * Minimal site footer — a hairline-topped row with the brand mark and a few
 * muted links. Sits at the bottom of the main app pages.
 */
export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-16 border-t border-fh-border">
      <div className="max-w-[1280px] mx-auto px-4 py-6 flex flex-col sm:flex-row items-center gap-3 text-fh-sm text-fh-fg-muted">
        <Link to="/" aria-label="ForgeHub home" className="text-fh-fg-subtle hover:text-fh-accent-fg">
          <ForgeLogo size={20} />
        </Link>
        <span>© {year} ForgeHub</span>
        <nav className="sm:ml-auto flex items-center gap-4">
          <a href="https://github.com/ForgeHubProject/ForgeHub" className="hover:text-fh-accent-fg hover:underline">
            Source
          </a>
          <Link to="/settings/tokens" className="hover:text-fh-accent-fg hover:underline">
            Developer settings
          </Link>
        </nav>
      </div>
    </footer>
  );
}
