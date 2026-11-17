import { Injectable } from '@nestjs/common';
import { NotificationPort, type NotificationMessage } from '../ports/ports.js';

/** Test double: records messages so tests can read verification tokens / OTPs. */
@Injectable()
export class InMemoryNotificationAdapter extends NotificationPort {
  readonly sent: NotificationMessage[] = [];

  send(message: NotificationMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  last<T extends NotificationMessage['type']>(
    type: T,
    to?: string,
  ): Extract<NotificationMessage, { type: T }> | undefined {
    return [...this.sent]
      .reverse()
      .find(
        (m) =>
          m.type === type &&
          (to === undefined ||
            ('email' in m && m.email === to) ||
            ('phone' in m && m.phone === to)),
      ) as Extract<NotificationMessage, { type: T }> | undefined;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
