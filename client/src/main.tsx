import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const OWNER_SESSION_STORAGE_KEY = "private-owner-session";

async function bootstrapPrivateOwnerAccess(): Promise<boolean> {
  if (window.location.pathname !== "/owner-access") return false;

  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : "";
  const bootstrapToken = new URLSearchParams(fragment).get("token");

  // Remove the one-time credential before any network request, render, referrer,
  // or browser-history entry can retain it.
  window.history.replaceState(null, "", "/owner-access");

  if (!bootstrapToken) {
    window.location.replace("/");
    return true;
  }

  try {
    const response = await fetch("/api/private-owner/access", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: bootstrapToken }),
    });

    if (!response.ok) throw new Error("Owner access link is invalid or expired");
    const body = (await response.json()) as { sessionToken?: unknown };
    if (typeof body.sessionToken !== "string" || body.sessionToken.length === 0) {
      throw new Error("Owner session was not established");
    }

    try {
      sessionStorage.setItem(OWNER_SESSION_STORAGE_KEY, body.sessionToken);
    } catch {
      // The first-party HttpOnly cookie remains the primary session path.
    }
  } catch {
    try {
      sessionStorage.removeItem(OWNER_SESSION_STORAGE_KEY);
    } catch {}
  }

  window.location.replace("/");
  return true;
}

const queryClient = new QueryClient();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      headers() {
        // Mobile in-app browsers can reject cookies. The direct owner bootstrap
        // supplies a same-tab bearer fallback without any external sign-in.
        try {
          const token = sessionStorage.getItem(OWNER_SESSION_STORAGE_KEY);
          if (token) {
            return { Authorization: `Bearer ${token}` };
          }
        } catch {
          // sessionStorage unavailable
        }
        return {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

void bootstrapPrivateOwnerAccess().then(redirected => {
  if (redirected) return;
  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
});
