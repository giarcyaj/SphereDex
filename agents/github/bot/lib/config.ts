/**
 * Repos the GitHub agent watches through Cursor account SCM events.
 * Leave empty so `bdk call` / `bdk eval` / `bdk dev` boot without login.
 * Fill before production event streaming:
 *   ["giarcyaj/spheredex", "giarcyaj/spheredex-backend"]
 */
export default {
  repos: [] as string[],
};
