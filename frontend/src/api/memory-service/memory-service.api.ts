import { openHands } from "#/api/open-hands-axios";

export interface MemoryDocument {
  text: string;
  max_chars: number;
  used_chars: number;
}

/**
 * The durable per-customer memory document.
 *
 * It is injected into the system message of EVERY conversation the customer
 * starts (`memory_block` in nimbus_memory.py, wired at
 * live_status_app_conversation_service.py:496), which is why the cap matters
 * and why the server returns it: unbounded memory is a silent tax on the
 * context window, and the customer would experience it as the agent forgetting
 * earlier turns rather than as a file that grew.
 */
class MemoryService {
  static async get(): Promise<MemoryDocument> {
    const { data } = await openHands.get<MemoryDocument>("/api/v1/memory");
    return data;
  }

  /**
   * Returns WHAT WAS STORED, not what was sent — the server truncates to the
   * cap. Callers must render the response rather than the value they submitted,
   * or the customer believes they saved more than they did.
   */
  static async save(text: string): Promise<MemoryDocument> {
    const { data } = await openHands.put<MemoryDocument>("/api/v1/memory", {
      text,
    });
    return data;
  }
}

export default MemoryService;
