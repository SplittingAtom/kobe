import net from "node:net";

/** A connected pair of loopback sockets: closing one end closes the other (unlike `duplexPair`). */
export async function socketPair(): Promise<[net.Socket, net.Socket]> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  const client = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const peer = await accepted;
  server.close();
  return [client, peer];
}
