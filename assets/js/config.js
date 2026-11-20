/**
 * Tattoo Removal Tracker — website configuration.
 *
 * One place for the values the whole site shares. The Google Web
 * OAuth client id is a PUBLIC identifier (it ships in the page);
 * the API base is the production tracker backend. Sign-in only
 * works from authorized origins (https://tattooremovaltracker.com);
 * from any other origin Google refuses and the sign-in screen
 * shows that refusal plainly instead of failing silently.
 */
export const GOOGLE_CLIENT_ID =
  "314727821938-mqnsgqtggds11vsgi1lco927u37vfafh.apps.googleusercontent.com";

export const API_BASE = "https://api.inkwasher.com/v1";

/** localStorage keys — the same names the phone app's kv uses, so
 * the two codebases read as one system. */
export const DEVICE_KEY = "tattoo-tracker.cloud-sync.device";
export const STATE_KEY = "tattoo-tracker.cloud-sync.state.v1";

export const APP_NAME = "Tattoo Removal Tracker";
export const APP_BYLINE = "by INKWASHER";
