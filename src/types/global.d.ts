import type { SiyloBridge } from "@/lib/siylo-types";

declare global {
  interface Window {
    siylo?: SiyloBridge;
  }
}

export {};
