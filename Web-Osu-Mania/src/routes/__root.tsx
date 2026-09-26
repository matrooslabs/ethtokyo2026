/// <reference types="vite/client" />
import ReactScan from "@/components/debug/reactScan";
import Header from "@/components/header";
import Html from "@/components/html";
import SuiProvider from "@/components/sui/suiProvider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { seo } from "@/lib/seo";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import appCss from "../styles/globals.css?url";

const title = "versu! · four keys, one leaderboard";
const description =
  "Play the four-key rhythm challenge with a verified device. One USDC buys three plays; the highest verified score takes the daily prize.";
const ogImageUrl = "/versu-logo.png";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        name: "apple-mobile-web-app-title",
        content: "versu!",
      },
      ...seo({ title, description, image: ogImageUrl }),
    ],
    links: [
      {
        rel: "preload",
        href: `${import.meta.env.BASE_URL}fonts/Silkscreen-Regular.ttf`,
        as: "font",
        type: "font/ttf",
        crossOrigin: "anonymous",
      },
      { rel: "icon", type: "image/png", href: "/versu-logo.png" },
      { rel: "apple-touch-icon", href: "/versu-logo.png" },
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "manifest",
        href: "/site.webmanifest",
      },
    ],
  }),
  component: RootLayout,
});

function RootLayout() {
  return (
    <Html>
      <head>
        <HeadContent />
      </head>
      <body className="">
        <TooltipProvider>
          <SuiProvider>
            <a className="arena-skip" href="#main-content">
              Skip to content
            </a>
            <Header />

            <main
              id="main-content"
              tabIndex={-1}
              className="[view-transition-name:main-content]"
            >
              <Outlet />
            </main>

            <Toaster />
            <ReactScan />
          </SuiProvider>
        </TooltipProvider>

        <Scripts />
      </body>
    </Html>
  );
}
