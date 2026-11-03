import { Fragment, type ReactNode } from "react";

/**
 * Like `fill`, for templates whose placeholders hold elements (a <time>, a strong label).
 * Unknown placeholders stay visible rather than inventing text.
 */
export function fillNodes(template: string, values: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/(\{\w+\})/g);
  return parts.map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    const value = key !== undefined && key in values ? values[key] : part;
    return <Fragment key={i}>{value}</Fragment>;
  });
}
