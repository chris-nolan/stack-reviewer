import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { SessionProvider } from "./app/session";
import { initDurable } from "./lib/durable";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => {
        const status = (err as unknown as { status?: number }).status;
        return count < 2 && !(status && [401, 403, 404].includes(status));
      },
      refetchOnWindowFocus: true,
    },
  },
});

const tree = (
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(<div className="boot">Starting…</div>);

// Durable state (SQLite on desktop) is loaded once before anything reads it.
initDurable()
  .catch((e) => console.error("durable state failed to load", e))
  .finally(() => root.render(tree));
