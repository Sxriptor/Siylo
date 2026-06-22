import type { SiyloBridge } from "@/lib/siylo-types";

declare global {
  interface Window {
    __siyloNativeVolumeAction?: (action: "volume-up" | "volume-up-start" | "volume-up-stop" | "volume-down") => void;
    siylo?: SiyloBridge;
  }
}

export {};
