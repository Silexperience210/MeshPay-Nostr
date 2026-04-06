declare module "expo-camera";
declare module "tiny-secp256k1";
declare module "@testing-library/react-native" {
  export function renderHook<T>(callback: () => T, options?: any): {
    result: { current: T };
    rerender: (props?: any) => void;
    unmount: () => void;
    waitForNextUpdate: () => Promise<void>;
  };
  export function act(callback: () => void | Promise<void>): Promise<void>;
  export function waitFor(callback: () => void, options?: any): Promise<void>;
}
