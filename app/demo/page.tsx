import type { Metadata } from "next";

import { VisualMvpDemo } from "./visual-mvp-demo";

export const metadata: Metadata = {
  title: "Marat Events — Visual MVP",
  description: "Interactive visual MVP for the Marat Events guest and operator experience.",
};

export default function DemoPage() {
  return <VisualMvpDemo />;
}
