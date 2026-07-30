import { isAuthApiError } from "@supabase/supabase-js";

/**
 * Supabase deliberately returns the same "invalid_credentials" code for both
 * a wrong password and a nonexistent account — telling those apart would be
 * a user-enumeration hole, so we don't try. Codes are the real GoTrue error
 * codes (see @supabase/auth-js/error-codes), not guessed message strings.
 */
export function describeAuthError(error: unknown): string {
  if (!isAuthApiError(error)) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }

  switch (error.code) {
    case "invalid_credentials":
      return "That email and password don't match. If you signed up with Google or GitHub, use that button below instead.";
    case "email_not_confirmed":
      return "Please confirm your email before logging in.";
    case "user_already_exists":
    case "email_exists":
      return "An account with that email already exists — try logging in instead, or use Google/GitHub if that's how you signed up.";
    case "weak_password":
      return "That password is too weak — use at least 8 characters with a mix of letters and numbers.";
    case "email_address_invalid":
      return "Please enter a valid email address.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Too many attempts — please wait a moment and try again.";
    case "signup_disabled":
    case "email_provider_disabled":
      return "Sign-ups are temporarily disabled. Please try again later.";
    case "same_password":
      return "That's your current password — choose a different one.";
    default:
      return error.message;
  }
}
