import { Event } from "https://deno.land/x/async@v1.2.0/event.ts";
import { Queue } from "https://deno.land/x/async@v2.0.2/mod.ts";

export interface Channel<Send, Recv> {
  send: (data: Send) => void;
  recv: () => Promise<Recv>;
  closed: Event;
  ready: Event;
  close: () => void;
}

export const asChannel = async <Send, Recv>(
  socket: WebSocket,
): Promise<Channel<Send, Recv>> => {
  const ready = new Event();
  const recv = new Queue<string>();
  const closed = new Event();
  socket.addEventListener("open", () => {
    ready.set();
  });
  socket.addEventListener("close", (event) => {
    console.log("closed", event.reason, event.code, event.type);
    closed.set();
  });
  socket.addEventListener("message", (event) => {
    recv.push(event.data);
  });
  socket.addEventListener("error", (event) => {
    console.log("error", event);
  });

  await Promise.race([ready.wait(), closed.wait()]);
  return {
    close: () => {
      closed.set();
      socket.close();
    },
    send: (data: Send) => {
      if (!closed.is_set()) {
        const stringifiedData = JSON.stringify(data);
        socket.send(stringifiedData);
      }
    },
    recv: async () => {
      const received = await recv.pop();
      return received ? JSON.parse(received) : received;
    },
    closed,
    ready,
  };
};
