import { useNavigate } from "react-router-dom";
import { ForgeLogo } from "../components/ForgeLogo";
import { Button, Icons } from "../ui";
import { useDocumentTitle } from "./useDocumentTitle";

/**
 * Friendly catch-all 404. A large muted brand mark, plain microcopy, and two
 * ways out: the primary action home and a link into search. Standalone and
 * theme-aware — no header chrome, so it renders for signed-out visitors too.
 */
export function NotFoundPage() {
  useDocumentTitle("Not found · ForgeHub");
  const navigate = useNavigate();

  return (
    <main className="min-h-screen bg-fh-canvas flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="text-fh-fg-subtle mb-5">
        <ForgeLogo size={64} />
      </div>

      <p className="text-fh-sm font-medium text-fh-fg-subtle mb-2">404 · Page not found</p>

      <h1 className="text-fh-2xl font-semibold text-fh-fg text-balance">
        This is not the page you're looking for.
      </h1>

      <p className="mt-2 max-w-md text-fh-base text-fh-fg-muted">
        The page you requested doesn't exist, or it may have moved. Check the address, or
        head back and pick up where you left off.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" onClick={() => navigate("/")}>
          Back to ForgeHub
        </Button>
        <Button
          variant="default"
          leadingIcon={<Icons.SearchIcon />}
          onClick={() => navigate("/search")}
        >
          Search repositories
        </Button>
      </div>
    </main>
  );
}
