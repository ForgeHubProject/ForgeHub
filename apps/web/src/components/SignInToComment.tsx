import { Link } from "react-router-dom";
import { signInPath } from "../lib/guest";

/**
 * Where a signed-out visitor would find the comment box, as on GitHub: an
 * invitation to sign up or sign in, coming back to this conversation.
 */
export function SignInToComment() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-4 border-t border-fh-border">
      <p className="text-fh-sm text-fh-fg-muted">
        <Link
          to={signInPath(undefined, "register")}
          className="inline-flex items-center h-8 px-3 mr-2 rounded-md border border-transparent bg-fh-accent-emphasis text-fh-on-emphasis text-fh-base font-medium hover:bg-fh-accent-emphasis-hover"
        >
          Sign up
        </Link>
        to join this conversation.
      </p>
      <p className="text-fh-sm text-fh-fg-muted">
        Already have an account?{" "}
        <Link to={signInPath()} className="font-medium text-fh-accent-fg hover:underline">
          Sign in to comment
        </Link>
      </p>
    </div>
  );
}
