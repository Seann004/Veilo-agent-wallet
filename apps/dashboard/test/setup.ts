import { afterEach } from "vitest";
import { clearResourceCache } from "../components/hooks";

// Each test starts from an empty resource cache, as a fresh page load would.
afterEach(() => clearResourceCache());
