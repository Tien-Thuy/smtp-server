import net from "node:net";
import tls from "node:tls";

export interface IMAPServerEvents {
  connect: (event: {
    id: string;
    remoteAddress: string;
    secure: boolean
  }) => void;
  close: () => void;
  data: (event: {
    connection: IMAPConnection;
    data: Buffer;
  }) => void;
  timeout: (event: IMAPConnection) => void;
  listening: (info: {
    address: string;
    port: number;
    secure: boolean
  }) => void;
  error: (error: Error) => void;
  command: (event: { connection: IMAPConnection, command: string, args: string[] }) => void;

  LOGIN: (
    info: { connection: IMAPConnection; username: string; password: string },
    callback: (success: boolean) => void
  ) => void; // Xác thực đăng nhập.
  SELECT: (
    info: { connection: IMAPConnection; mailbox: string },
    callback: (success: boolean, exists: number, recent: number) => void
  ) => void; // Chọn hộp thư.
  FETCH: (
    info: {
      connection: IMAPConnection;
      sequence: string;
      items: string[];
    },
    callback: (data: string) => void
  ) => void; // Lấy dữ liệu/lá thư.
  STORE: (
    info: {
      connection: IMAPConnection;
      sequence: string;
      flags: string[];
    },
    callback: (success: boolean) => void
  ) => void; // Thay đổi trạng thái thư.
  EXPUNGE: (info: { connection: IMAPConnection }) => void; // Xóa các thư được đánh dấu xóa.
}

export interface IMAPServerConfig {
  host: string;
  port: number;
  welcomeMessage?: string;
  TLSOptions: {
    enable: boolean;
    key?: string;
    cert?: string;
    ca?: string;
  },
  idleTimeout?: number;
  maxConnections?: number;
  idLength?: number;
  storage?: IStorage;
}

export interface IStorage {
  get: (key: string) => Promise<IConnectInfo | undefined>;
  set: (key: string, value: IConnectInfo) => Promise<void>;
  destroy: (key: string) => Promise<void>;
  list: () => Promise<Map<string, IConnectInfo>>;
}

export interface IConnectInfo {
  state: 'non_authenticated' | 'authenticated' | 'selected' | 'logout';
  user?: string;
  selectedMailbox?: string;
  secure: boolean;
  mailbox?: string;
}

export interface IMAPConnection {
  id: string;
  socket: net.Socket | tls.TLSSocket;
}
