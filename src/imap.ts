import { EventEmitter } from 'events';
import * as net from "node:net";
import * as tls from "node:tls";
import * as randomString from "randomstring";
import { Buffer } from 'node:buffer';
import Storage from "./storage";
import {
  IMAPConnection,
  IMAPServerConfig
} from "./interface";
import * as console from "node:console";

export default class IMAPServer extends EventEmitter {
  private readonly config: IMAPServerConfig;
  private running: boolean;
  private server?: net.Server | tls.Server;
  private storage: Storage;
  private connected: IMAPConnection[];

  constructor(config: IMAPServerConfig) {
    super();

    // Cấu hình mặc định
    this.config = {
      welcomeMessage: 'Welcome to Custom IMAP Server',
      idleTimeout: 180000,
      maxConnections: 10,
      host: '0.0.0.0',
      port: 143,
      idLength: 22,
      TLSOptions: {
        enable: false,
        cert: null,
        key: null
      },
      ...config
    };

    this.running = false;
    this.connected = [];
    this.storage = new Storage();
  }

  /** Khởi động IMAP Server */
  public async start(): Promise<void> {
    if (this.running) {
      throw new Error('IMAP Server is already running.');
    }

    // Tạo server
    this.server = this.config.TLSOptions.enable
      ? tls.createServer(this.config.TLSOptions)
      : net.createServer();

    // Đăng ký sự kiện server
    this.server.on('connection', this.handleConnection.bind(this));
    this.server.on('error', this.handleError.bind(this));

    await new Promise<void>((resolve) =>
      this.server!.listen(this.config.port, this.config.host, () => {
        this.running = true;
        console.log(
          `IMAP Server running on ${this.config.host}:${this.config.port} ${
            this.config.TLSOptions.enable ? "(TLS)" : ""
          }`
        );
        resolve();
      })
    );
  }

  /** Dừng IMAP Server */
  public async stop(): Promise<void> {
    if (!this.running || !this.server) {
      throw new Error('IMAP Server is not running.');
    }

    this.connected.forEach((connection) => this.closeConnection(connection));
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve()))
    );

    this.running = false;
    console.log("IMAP Server stopped.");
  }

  /** Đóng kết nối */
  private async closeConnection(
    connection: IMAPConnection,
    reason: string = "Server shutdown"
  ): Promise<void> {
    try {
      if (!connection.socket.destroyed) {
        connection.socket.end(`* BYE ${reason}\r\n`);
        connection.socket.destroy();
      }
    } catch (error) {
      console.error(`Error closing connection ${connection.id}:`, error);
    } finally {
      this.connected = this.connected.filter((c) => c.id !== connection.id);
    }
  }

  /** Xử lý kết nối mới */
  private async handleConnection(socket: net.Socket | tls.TLSSocket): Promise<void> {
    if (this.config.maxConnections && this.connected.length >= this.config.maxConnections) {
      socket.end("* BYE Too many connections\r\n");
      return;
    }

    const secure = this.config.TLSOptions.enable || socket instanceof tls.TLSSocket;
    const connection: IMAPConnection = {
      id: randomString.generate(this.config.idLength),
      socket
    };
    await this.storage.set(connection.id, {
      state: "non_authenticated",
      secure
    });

    console.log(`[${connection.id}] New connection`);
    this.connected.push(connection);

    socket.on('data', (data) => this.handleData(connection, data));
    socket.on('close', () => this.handleClose(connection));
    socket.on('error', (error) => this.handleError(error));
    socket.write(`* OK ${this.config.welcomeMessage}\r\n`);
  }

  /** Xử lý dữ liệu nhận từ client */
  private async handleData(connection: IMAPConnection, data: Buffer): Promise<void> {
    const commandLine = data.toString('utf8').trim();
    console.log(`[${connection.id}] Received: ${commandLine}`);
    const [tag, command, ...args] = commandLine.split(' ');

    switch (command?.toUpperCase()) {
      case 'LOGIN':
        await this.commandLOGIN(connection, tag, args);
        break;
      case 'SELECT':
        await this.commandSELECT(connection, tag, args);
        break;
      case 'FETCH':
        await this.commandFETCH(connection, tag, args);
        break;
      case 'STORE':
        await this.commandSTORE(connection, tag, args);
        break;
      case 'LOGOUT':
        this.commandLOGOUT(connection, tag);
        break;
      default:
        connection.socket.write(`${tag} BAD Unknown command: ${command}\r\n`);
    }
  }

  /** Đăng nhập người dùng */
  private async commandLOGIN(connection: IMAPConnection, tag: string, args: string[]): Promise<void> {
    const [username, password] = args;
    if (!username || !password) {
      connection.socket.write(`${tag} BAD Missing username or password\r\n`);
      return;
    }

    const data = await this.storage.get(connection.id);
    await this.storage.set(connection.id, {
      ...data,
      state: 'authenticated'
    });
    this.emit('LOGIN', {connection, username, password}, (success: boolean) => {
      if (success) {
        connection.socket.write(`${tag} OK Logged in\r\n`);
      } else {
        connection.socket.write(`${tag} NO Authentication failed\r\n`);
      }
    });
  }

  /** Chọn hộp thư */
  private async commandSELECT(connection: IMAPConnection, tag: string, args: string[]): Promise<void> {
    const _connection = await this.storage.get(connection.id);
    const mailbox = args[0];
    if (!mailbox || _connection.state !== "authenticated") {
      connection.socket.write(`${tag} BAD You must be authenticated and provide a mailbox\r\n`);
      return;
    }

    this.emit('SELECT', {connection, mailbox}, async (success, exists, recent) => {
      if (success) {
        _connection.state = "selected";
        _connection.mailbox = mailbox;
        connection.socket.write(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n`);
        connection.socket.write(`* ${exists} EXISTS\r\n`);
        connection.socket.write(`* ${recent} RECENT\r\n`);
        connection.socket.write(`${tag} OK [READ-WRITE] Selected mailbox ${mailbox}\r\n`);
        await this.storage.set(connection.id, _connection);
      } else {
        connection.socket.write(`${tag} NO Mailbox not found\r\n`);
      }
    });
  }

  /** Lấy dữ liệu thư */
  private async commandFETCH(connection: IMAPConnection, tag: string, args: string[]): Promise<void> {
    const _connection = await this.storage.get(connection.id);
    if (_connection.state !== "selected") {
      connection.socket.write(`${tag} BAD No mailbox selected\r\n`);
      return;
    }

    const sequence = args[0];
    if (!sequence) {
      connection.socket.write(`${tag} BAD Missing sequence number\r\n`);
      return;
    }

    this.emit('FETCH', {connection, sequence, items: args.slice(1)}, (response) => {
      if (response) {
        connection.socket.write(response + '\r\n');
      } else {
        connection.socket.write(`${tag} NO Message not found\r\n`);
      }
    });
  }

  /** Cập nhật trạng thái thư */
  private async commandSTORE(connection: IMAPConnection, tag: string, args: string[]): Promise<void> {
    const _connection = await this.storage.get(connection.id);
    if (_connection.state !== "selected") {
      connection.socket.write(`${tag} BAD No mailbox selected\r\n`);
      return;
    }

    const sequence = args[0];
    const flags = args.slice(2);
    this.emit('STORE', {connection, sequence, flags}, (success) => {
      connection.socket.write(success ? `${tag} OK Flags updated\r\n` : `${tag} NO Unable to update flags\r\n`);
    });
  }

  /** Thoát client */
  private commandLOGOUT(connection: IMAPConnection, tag: string): void {
    connection.socket.write(`* BYE IMAP Server logging out\r\n`);
    connection.socket.write(`${tag} OK Logout completed\r\n`);
    connection.socket.end();
    this.connected = this.connected.filter((c) => c.id !== connection.id);
  }

  /** Xử lý lỗi */
  private handleError(error: Error): void {
    console.error('Server error:', error);
    this.emit('error', error);
  }

  /** Đóng kết nối */
  private handleClose(connection: IMAPConnection): void {
    this.connected = this.connected.filter((c) => c.id !== connection.id);
    console.log(`[${connection.id}] Connection closed`);
  }
}
