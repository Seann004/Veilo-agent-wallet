// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useResource } from "../components/hooks";
import { ApiError } from "../lib/api";

afterEach(cleanup);

function View({ load }: { load: () => Promise<string> }) {
  const r = useResource(load, "secret-list");
  return <p>{r.loading ? "loading" : (r.data ?? "nothing")}</p>;
}

describe("resource cache", () => {
  it("shows the last result on return, and drops it when the session is refused", async () => {
    render(<View load={async () => "owner A's data"} />);
    await screen.findByText("owner A's data");
    cleanup();

    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    render(
      <View
        load={async () => {
          await pending;
          throw new ApiError(401, "UNAUTHENTICATED", "signed out");
        }}
      />,
    );
    // While refreshing, the cached result is shown instead of an empty page.
    expect(screen.getByText("loading")).toBeTruthy();
    release();
    await screen.findByText("nothing");
    cleanup();

    render(<View load={() => new Promise<string>(() => undefined)} />);
    expect(screen.queryByText("owner A's data")).toBeNull();
  });
});
