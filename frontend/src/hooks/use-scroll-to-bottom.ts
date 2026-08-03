import { RefObject, useState, useCallback, useRef, useEffect } from "react";

export function useScrollToBottom(scrollRef: RefObject<HTMLDivElement | null>) {
  // Track whether the user is currently near the bottom of the scroll area.
  // Used by consumers to decide whether to scroll when new UI elements appear.
  // NOT used for automatic content-following.
  const [autoscroll, setAutoscroll] = useState(true);

  // Track whether the user is currently at the bottom of the scroll area
  const [hitBottom, setHitBottom] = useState(true);

  // Store previous scroll position to detect scroll direction
  const prevScrollTopRef = useRef<number>(0);

  // Check if the scroll position is at the bottom
  const isAtBottom = useCallback((element: HTMLElement): boolean => {
    // Use a fixed 20px buffer
    const bottomThreshold = 20;
    const bottomPosition = element.scrollTop + element.clientHeight;
    return bottomPosition >= element.scrollHeight - bottomThreshold;
  }, []);

  // Handle scroll events
  const onChatBodyScroll = useCallback(
    (e: HTMLElement) => {
      const isCurrentlyAtBottom = isAtBottom(e);
      setHitBottom(isCurrentlyAtBottom);

      // Get current scroll position
      const currentScrollTop = e.scrollTop;

      // Detect scroll direction
      const isScrollingUp = currentScrollTop < prevScrollTopRef.current;

      // Update previous scroll position for next comparison
      prevScrollTopRef.current = currentScrollTop;

      // Turn off autoscroll only when scrolling up
      if (isScrollingUp) {
        setAutoscroll(false);
      }

      // Turn on autoscroll when scrolled to the bottom
      if (isCurrentlyAtBottom) {
        setAutoscroll(true);
      }
    },
    [isAtBottom],
  );

  // Mirror of `autoscroll` for the observer below, which is attached once and
  // must not be torn down and re-attached on every state change.
  const autoscrollRef = useRef(autoscroll);
  autoscrollRef.current = autoscroll;

  /*
   * Follow content as it GROWS, not just when a message is added.
   *
   * chat-interface already scrolls on `v1UiEvents.length` / `v0Events.length`.
   * That fires once, when an event first appears — and an assistant reply
   * appears as a single event that then streams in. The count never changes
   * again, so the view scrolls to the top of the reply and stops, and the text
   * grows away off-screen. Same for a tool output that expands, an image that
   * loads late, or a diff that renders after its container.
   *
   * A ResizeObserver on the scrolled content catches every one of those,
   * because they all end in the same observable fact: the content got taller.
   *
   * Still gated on `autoscroll`, so a user who has scrolled up to read is left
   * alone — that flag only goes back to true when they return to the bottom.
   */
  useEffect(() => {
    const dom = scrollRef.current;
    if (!dom || typeof ResizeObserver === "undefined") return undefined;

    const follow = () => {
      if (autoscrollRef.current) {
        dom.scrollTop = dom.scrollHeight;
      }
    };

    const observer = new ResizeObserver(follow);
    // Observe the children rather than the container: the container's own box
    // is fixed by the layout, so only its content changes height.
    Array.from(dom.children).forEach((child) => observer.observe(child));

    // Children can be replaced wholesale on a conversation switch, so watch
    // for that too and re-target.
    const mutation = new MutationObserver(() => {
      observer.disconnect();
      Array.from(dom.children).forEach((child) => observer.observe(child));
      follow();
    });
    mutation.observe(dom, { childList: true });

    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [scrollRef]);

  // Scroll to bottom on manual click only
  const scrollDomToBottom = useCallback(() => {
    const dom = scrollRef.current;
    if (dom) {
      requestAnimationFrame(() => {
        setAutoscroll(true);
        setHitBottom(true);

        dom.scrollTop = dom.scrollHeight;
      });
    }
  }, [scrollRef]);

  return {
    scrollRef,
    autoScroll: autoscroll,
    setAutoScroll: setAutoscroll,
    scrollDomToBottom,
    hitBottom,
    setHitBottom,
    onChatBodyScroll,
  };
}
