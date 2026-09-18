import { createContext, useContext } from "react";

export const PhoneModeContext = createContext(false);
export function usePhoneMode(): boolean { return useContext(PhoneModeContext); }
