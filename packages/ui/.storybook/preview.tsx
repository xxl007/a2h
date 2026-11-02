import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import "../src/tokens/tokens.css";
import "../src/tokens/base.css";

/** Sets data-theme on <html>, as apps/web does for an explicit override (skill §2.3). */
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals["theme"] as string | undefined;
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }, [theme]);
  return <Story />;
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Colour scheme",
      toolbar: {
        title: "Theme",
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "system" },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        phone: { name: "Phone 390", styles: { width: "390px", height: "844px" } },
        desktop: { name: "Desktop 1280", styles: { width: "1280px", height: "800px" } },
      },
    },
  },
};

export default preview;
