"use client";

import {
  useRef,
  useEffect,
  useState,
  type ReactNode,
  type CSSProperties,
  type RefObject,
} from "react";
import { gsap } from "gsap";
import "./MagicBento.css";

const DEFAULT_SPOTLIGHT_RADIUS = 300;
const DEFAULT_GLOW_COLOR = "var(--bento-glow-rgb)";
const MOBILE_BREAKPOINT = 768;
const CARD_BG = "var(--card)";

export type MagicBentoCard = {
  color?: string;
  title: string;
  description: string;
  label: string;
  visual?: ReactNode;
  large?: boolean;
};

type MagicBentoProps = {
  cards: MagicBentoCard[];
  textAutoHide?: boolean;
  enableSpotlight?: boolean;
  enableBorderGlow?: boolean;
  disableAnimations?: boolean;
  spotlightRadius?: number;
  glowColor?: string;
  clickEffect?: boolean;
};

function calculateSpotlightValues(radius: number): {
  proximity: number;
  fadeDistance: number;
} {
  return {
    proximity: radius * 0.5,
    fadeDistance: radius * 0.75,
  };
}

function InteractiveCard({
  children,
  className = "",
  disableAnimations = false,
  style,
  glowColor = DEFAULT_GLOW_COLOR,
  clickEffect = false,
}: {
  children: ReactNode;
  className?: string;
  disableAnimations?: boolean;
  style?: CSSProperties;
  glowColor?: string;
  clickEffect?: boolean;
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disableAnimations || !cardRef.current) return;

    const element = cardRef.current;

    const handleClick = (e: MouseEvent): void => {
      if (!clickEffect) return;

      const rect = element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const maxDistance = Math.max(
        Math.hypot(x, y),
        Math.hypot(x - rect.width, y),
        Math.hypot(x, y - rect.height),
        Math.hypot(x - rect.width, y - rect.height),
      );

      const ripple = document.createElement("div");
      ripple.style.cssText = `
        position: absolute;
        width: ${maxDistance * 2}px;
        height: ${maxDistance * 2}px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(${glowColor}, 0.35) 0%, rgba(${glowColor}, 0.12) 30%, transparent 70%);
        left: ${x - maxDistance}px;
        top: ${y - maxDistance}px;
        pointer-events: none;
        z-index: 1000;
      `;

      element.appendChild(ripple);

      gsap.fromTo(
        ripple,
        { scale: 0.92, opacity: 0.6 },
        {
          scale: 1,
          opacity: 0,
          duration: 0.18,
          ease: "power2.out",
          onComplete: () => ripple.remove(),
        },
      );
    };

    element.addEventListener("click", handleClick);

    return () => {
      element.removeEventListener("click", handleClick);
    };
  }, [disableAnimations, clickEffect, glowColor]);

  return (
    <div
      ref={cardRef}
      className={`${className} magic-bento-interactive`}
      style={{ ...style, position: "relative", overflow: "hidden" }}
    >
      {children}
    </div>
  );
}

function GlobalSpotlight({
  gridRef,
  disableAnimations = false,
  enabled = true,
  spotlightRadius = DEFAULT_SPOTLIGHT_RADIUS,
  glowColor = DEFAULT_GLOW_COLOR,
}: {
  gridRef: RefObject<HTMLDivElement | null>;
  disableAnimations?: boolean;
  enabled?: boolean;
  spotlightRadius?: number;
  glowColor?: string;
}): null {
  const spotlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (disableAnimations || !gridRef?.current || !enabled) return;

    const spotlight = document.createElement("div");
    spotlight.className = "global-spotlight";
    spotlight.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 420px;
      height: 420px;
      border-radius: 50%;
      pointer-events: none;
      background: radial-gradient(circle,
        rgba(${glowColor}, 0.1) 0%,
        rgba(${glowColor}, 0.05) 15%,
        rgba(${glowColor}, 0.025) 25%,
        rgba(${glowColor}, 0.012) 40%,
        rgba(${glowColor}, 0.005) 65%,
        transparent 70%
      );
      z-index: 200;
      opacity: 0;
      transform: translate3d(-50%, -50%, 0);
      will-change: transform, opacity;
      mix-blend-mode: screen;
    `;
    document.body.appendChild(spotlight);
    spotlightRef.current = spotlight;

    let cachedSectionRect: DOMRect | null = null;
    let cachedCards: { el: HTMLElement; rect: DOMRect }[] = [];
    let rectsDirty = true;
    const invalidateRects = (): void => {
      rectsDirty = true;
    };
    const ensureRects = (): void => {
      if (!rectsDirty || !gridRef.current) return;
      rectsDirty = false;
      const section = gridRef.current.closest(".bento-section");
      cachedSectionRect = section?.getBoundingClientRect() ?? null;
      cachedCards = Array.from(
        gridRef.current.querySelectorAll<HTMLElement>(".magic-bento-card"),
      ).map((el) => ({ el, rect: el.getBoundingClientRect() }));
    };

    let rafId: number | null = null;
    let latestMouse: { x: number; y: number } | null = null;
    let wasInside = false;

    const applySpotlight = (): void => {
      rafId = null;
      if (!spotlightRef.current || !gridRef.current || !latestMouse) return;
      ensureRects();

      const { x: clientX, y: clientY } = latestMouse;
      const rect = cachedSectionRect;
      const mouseInside =
        !!rect &&
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;

      if (!mouseInside) {
        if (!wasInside) return;
        wasInside = false;
        gsap.to(spotlightRef.current, {
          opacity: 0,
          duration: 0.3,
          ease: "power2.out",
          overwrite: "auto",
        });
        for (const { el } of cachedCards) {
          el.style.setProperty("--glow-intensity", "0");
        }
        return;
      }
      wasInside = true;

      const { proximity, fadeDistance } =
        calculateSpotlightValues(spotlightRadius);
      let minDistance = Infinity;

      for (const { el: cardElement, rect: cardRect } of cachedCards) {
        const centerX = cardRect.left + cardRect.width / 2;
        const centerY = cardRect.top + cardRect.height / 2;
        const distance =
          Math.hypot(clientX - centerX, clientY - centerY) -
          Math.max(cardRect.width, cardRect.height) / 2;
        const effectiveDistance = Math.max(0, distance);

        minDistance = Math.min(minDistance, effectiveDistance);

        let glowIntensity = 0;
        if (effectiveDistance <= proximity) {
          glowIntensity = 1;
        } else if (effectiveDistance <= fadeDistance) {
          glowIntensity =
            (fadeDistance - effectiveDistance) / (fadeDistance - proximity);
        }

        const relativeX = ((clientX - cardRect.left) / cardRect.width) * 100;
        const relativeY = ((clientY - cardRect.top) / cardRect.height) * 100;
        cardElement.style.setProperty("--glow-x", `${relativeX}%`);
        cardElement.style.setProperty("--glow-y", `${relativeY}%`);
        cardElement.style.setProperty("--glow-intensity", glowIntensity.toString());
        cardElement.style.setProperty("--glow-radius", `${spotlightRadius}px`);
      }

      gsap.to(spotlightRef.current, {
        x: clientX,
        y: clientY,
        xPercent: -50,
        yPercent: -50,
        duration: 0.1,
        ease: "power2.out",
        overwrite: "auto",
      });

      const targetOpacity =
        minDistance <= proximity
          ? 0.55
          : minDistance <= fadeDistance
            ? ((fadeDistance - minDistance) / (fadeDistance - proximity)) * 0.55
            : 0;

      gsap.to(spotlightRef.current, {
        opacity: targetOpacity,
        duration: targetOpacity > 0 ? 0.2 : 0.5,
        ease: "power2.out",
        overwrite: "auto",
      });
    };

    const handleMouseMove = (e: MouseEvent): void => {
      latestMouse = { x: e.clientX, y: e.clientY };
      if (rafId === null) rafId = requestAnimationFrame(applySpotlight);
    };

    const handleMouseLeave = (): void => {
      wasInside = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      for (const { el } of cachedCards) {
        el.style.setProperty("--glow-intensity", "0");
      }
      if (spotlightRef.current) {
        gsap.to(spotlightRef.current, {
          opacity: 0,
          duration: 0.3,
          ease: "power2.out",
          overwrite: "auto",
        });
      }
    };

    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave);
    window.addEventListener("resize", invalidateRects, { passive: true });
    window.addEventListener("scroll", invalidateRects, { capture: true, passive: true });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("resize", invalidateRects);
      window.removeEventListener("scroll", invalidateRects, true);
      spotlightRef.current?.parentNode?.removeChild(spotlightRef.current);
    };
  }, [gridRef, disableAnimations, enabled, spotlightRadius, glowColor]);

  return null;
}

function useMobileDetection(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = (): void =>
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return isMobile;
}

export function MagicBento({
  cards,
  textAutoHide = true,
  enableSpotlight = true,
  enableBorderGlow = true,
  disableAnimations = false,
  spotlightRadius = DEFAULT_SPOTLIGHT_RADIUS,
  glowColor = DEFAULT_GLOW_COLOR,
  clickEffect = true,
}: MagicBentoProps): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null);
  const isMobile = useMobileDetection();
  const shouldDisableAnimations = disableAnimations || isMobile;

  return (
    <div className="magic-bento-root">
      {enableSpotlight ? (
        <GlobalSpotlight
          gridRef={gridRef}
          disableAnimations={shouldDisableAnimations}
          enabled={enableSpotlight}
          spotlightRadius={spotlightRadius}
          glowColor={glowColor}
        />
      ) : null}

      <div className="card-grid bento-section" ref={gridRef}>
        {cards.map((card) => {
          const baseClassName = [
            "magic-bento-card",
            textAutoHide && !card.large
              ? "magic-bento-card--text-autohide"
              : "",
            card.large ? "magic-bento-card--large" : "",
            enableBorderGlow ? "magic-bento-card--border-glow" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const cardStyle = {
            backgroundColor: card.color ?? CARD_BG,
            "--glow-color": glowColor,
          } as CSSProperties;

          const content = (
            <>
              <div className="magic-bento-card__header">
                <div className="magic-bento-card__label">{card.label}</div>
              </div>
              {card.visual ? (
                <div className="magic-bento-card__visual">{card.visual}</div>
              ) : null}
              <div className="magic-bento-card__content">
                <h3 className="magic-bento-card__title">{card.title}</h3>
                <p className="magic-bento-card__description">
                  {card.description}
                </p>
              </div>
            </>
          );

          return (
            <InteractiveCard
              key={card.title}
              className={baseClassName}
              style={cardStyle}
              disableAnimations={shouldDisableAnimations}
              glowColor={glowColor}
              clickEffect={clickEffect}
            >
              {content}
            </InteractiveCard>
          );
        })}
      </div>
    </div>
  );
}
