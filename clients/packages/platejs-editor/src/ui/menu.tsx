"use client";

import {
  Combobox as AriakitCombobox,
  ComboboxItem as AriakitComboboxItem,
  ComboboxList as AriakitComboboxList,
  ComboboxProvider as AriakitComboboxProvider,
  type ComboboxProviderProps as AriakitComboboxProviderProps,
  MenuButton as AriakitMenuButton,
  MenuButtonArrow as AriakitMenuButtonArrow,
  MenuGroup as AriakitMenuGroup,
  MenuGroupLabel as AriakitMenuGroupLabel,
  MenuItem as AriakitMenuItem,
  MenuItemCheck as AriakitMenuItemCheck,
  MenuItemRadio as AriakitMenuItemRadio,
  Menu as AriakitMenuPrimitive,
  type MenuProps as AriakitMenuProps,
  MenuProvider as AriakitMenuProvider,
  type MenuProviderProps as AriakitMenuProviderProps,
  MenuSeparator as AriakitMenuSeparator,
  VisuallyHidden as AriakitVisuallyHidden,
  useMenuContext as useAriakitMenuContext,
  useMenuStore as useAriakitMenuStore,
  useComboboxContext,
} from "@ariakit/react";
import { useComposedRef } from "@udecode/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { ArrowElbowDownLeftIcon as CornerDownLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowElbowDownLeft";
import {
  type ComponentProps,
  createContext,
  isValidElement,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useOnClickOutside } from "../hooks/use-on-click-outside";
import { cn } from "../lib/utils";

export type Action = {
  filterItems?: boolean;
  focusEditor?: boolean;
  group?: string;
  icon?: ReactNode;
  items?: Action[];
  keywords?: string[];
  label?: string;
  shortcut?: string;
  value?: string;
};

export type ActionGroup = {
  group?: string;
  value?: string;
};

const SearchableContext = createContext(false);

const MenuContext = createContext<{
  isRootMenu: boolean;
  open: boolean;
}>({
  isRootMenu: false,
  open: false,
});

export type MenuProps = AriakitMenuProviderProps & {
  trigger?: ReactNode;
  value?: string;
  onOpenChange?: AriakitMenuProviderProps["setOpen"];
  onRootMenuClose?: () => void;
  onValueChange?: AriakitComboboxProviderProps["setValue"];
  onValuesChange?: AriakitMenuProviderProps["setValues"];
};

export function Menu({
  children,
  trigger,
  value,
  onOpenChange,
  onRootMenuClose,
  onValueChange,
  onValuesChange,
  ...props
}: MenuProps) {
  const isRootMenu = !useAriakitMenuContext();
  const [open, setOpen] = useState(false);

  const searchable = !!onValuesChange || isRootMenu;

  const content = (
    <AriakitMenuProvider
      open={open}
      setOpen={(v) => {
        if (props.open === undefined) {
          setOpen(v);
        }

        onOpenChange?.(v);
      }}
      setValues={onValuesChange}
      showTimeout={100}
      {...props}
    >
      {trigger}

      <MenuContext.Provider value={{ isRootMenu, open: props.open ?? open }}>
        <SearchableContext.Provider value={searchable}>
          {children}
        </SearchableContext.Provider>
      </MenuContext.Provider>
    </AriakitMenuProvider>
  );

  return searchable ? (
    <AriakitComboboxProvider
      includesBaseElement={false}
      resetValueOnHide
      setValue={onValueChange}
      value={value}
    >
      {content}
    </AriakitComboboxProvider>
  ) : (
    content
  );
}

export function MenuTrigger({
  children,
  icon,
  label,
  ...props
}: ComponentProps<typeof AriakitMenuButton> & {
  icon?: ReactNode;
  label?: ReactNode;
}) {
  const render = isValidElement(children) ? children : <MenuItem />;

  return (
    <AriakitMenuButton render={render} {...props}>
      {icon}
      {label && <span>{label}</span>}
      <AriakitMenuButtonArrow className="ml-auto text-muted-foreground/80" />
    </AriakitMenuButton>
  );
}

const menuVariants = cva(
  cn(
    "group/menu",
    "z-50 flex h-full min-w-[180px] max-w-[calc(100vw-24px)] flex-col p-0 text-popover-foreground",
    "data-[state=closed]:hidden"
  ),
  {
    defaultVariants: {
      animateZoom: false,
      variant: "default",
    },
    variants: {
      animateZoom: {
        false: "data-[state=open]:animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none",
        true: "data-[side=bottom]:origin-top data-[side=left]:origin-right data-[side=right]:origin-left data-[side=top]:origin-bottom data-[state=open]:animate-in zoom-in-95 motion-reduce:animate-none",
      },
      variant: {
        ai: "w-full px-12 sm:px-[max(64px,calc(50%-350px))]",
        aiSub: "max-h-[70vh] w-[220px] rounded-xl border border-border bg-popover shadow-popover",
        default:
          "max-h-[70vh] w-[260px] overflow-y-auto rounded-xl border border-border bg-popover shadow-popover",
      },
    },
  }
);

export type MenuContentProps = Omit<AriakitMenuProps, "onClickOutside"> &
  VariantProps<typeof menuVariants> & {
    animateZoom?: boolean;
    onClickOutside?: (event: MouseEvent) => void;
  };

export function MenuContent({
  animateZoom,
  children,
  className,
  ref,
  variant,
  onClickOutside,
  ...props
}: MenuContentProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { open } = useContext(MenuContext);
  const side = useMenuSide();

  // @ts-expect-error -- React MouseEvent vs DOM MouseEvent mismatch from Ariakit props
  useOnClickOutside(menuRef, onClickOutside);

  return (
    <AriakitMenuPrimitive
      className={cn(menuVariants({ animateZoom, variant }), className)}
      data-side={side}
      data-state={open ? "open" : "closed"}
      fitViewport={true}
      flip
      gutter={4}
      ref={useComposedRef(ref, menuRef)}
      unmountOnHide
      {...props}
    >
      {children}
    </AriakitMenuPrimitive>
  );
}

export function MenuSeparator(
  props: ComponentProps<typeof AriakitMenuSeparator>
) {
  return <AriakitMenuSeparator {...props} className={cn(props.className)} />;
}

export function MenuGroup({
  label,
  ...props
}: ComponentProps<typeof AriakitMenuGroup> & {
  label?: ReactNode;
}) {
  return (
    <>
      <MenuSeparator
        className={cn(
          "hidden",
          "peer-has-[[role=menuitem]]/menu-group:block peer-has-[[role=option]]/menu-group:block"
        )}
      />

      <AriakitMenuGroup
        {...props}
        className={cn(
          "hidden",
          "peer/menu-group group/menu-group my-1.5 has-[[role=menuitem]]:block has-[[role=option]]:block",
          props.className
        )}
      >
        {label && (
          <AriakitMenuGroupLabel className="select-none px-[14px] pt-1.5 pb-2 font-medium text-muted-foreground text-xs">
            {label}
          </AriakitMenuGroupLabel>
        )}
        {props.children}
      </AriakitMenuGroup>
    </>
  );
}

export function MenuShortcut({ ...props }: ComponentProps<"span">) {
  return (
    <span
      {...props}
      className={cn("text-muted-foreground/80 text-xs", props.className)}
    />
  );
}

const menuItemVariants = cva(
  "group/menu-item relative flex min-h-[28px] select-none items-center justify-between gap-2 px-2.5 text-accent-foreground text-sm outline-hidden transition-colors data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4",
  {
    defaultVariants: {
      isEmpty: false,
      variant: "default",
    },
    variants: {
      isEmpty: {
        false:
          "cursor-pointer hover:bg-accent aria-expanded:bg-accent aria-selected:bg-accent data-active-item:bg-accent data-active-item:text-accent-foreground",
        true: "text-muted-foreground",
      },
      variant: {
        default: "mx-1 w-[calc(100%-8px)] rounded-md",
      },
    },
  }
);

export type MenuItemProps = Omit<
  ComponentProps<typeof AriakitComboboxItem>,
  "store"
> & {
  checked?: boolean;
  group?: string;
  icon?: ReactNode;
  label?: string;
  name?: string;
  parentGroup?: string;
  preventClose?: boolean;
  shortcut?: ReactNode;
  shortcutEnter?: boolean;
  value?: string;
} & VariantProps<typeof menuItemVariants>;

function renderMenuItemChildren({
  checked,
  children,
  icon,
  label,
  searchable,
  shortcut,
  shortcutEnter,
}: Pick<
  MenuItemProps,
  "checked" | "icon" | "label" | "shortcut" | "shortcutEnter"
> & {
  children: MenuItemProps["children"];
  searchable: boolean;
}) {
  const hasShortcut = !!shortcut || shortcutEnter;

  return (
    <>
      <div className="flex w-full items-center gap-2 whitespace-nowrap">
        {icon && (
          <span className="menu-item-icon text-muted-foreground">{icon}</span>
        )}
        {children ?? label}
      </div>

      {(hasShortcut || checked) && (
        <div className="flex shrink-0 items-center justify-end">
          {checked && <AriakitMenuItemCheck checked={checked} />}
          {hasShortcut && (
            <MenuShortcut>
              {shortcut ?? (
                <CornerDownLeftIcon className="hidden group-data-[active-item='true']/menu-item:inline-block" />
              )}
            </MenuShortcut>
          )}
          {checked && searchable && (
            <AriakitVisuallyHidden>
              {checked ? "checked" : "not checked"}
            </AriakitVisuallyHidden>
          )}
        </div>
      )}
    </>
  );
}

function shouldKeepMenuOpen(
  event: MouseEvent<HTMLElement>,
  preventClose?: boolean
) {
  const expandable = event.currentTarget.hasAttribute("aria-expanded");

  return expandable || Boolean(preventClose);
}

export function MenuItem({
  checked,
  className,
  group,
  icon,
  isEmpty,
  label,
  name,
  parentGroup,
  preventClose,
  shortcut,
  shortcutEnter,
  variant,
  ...props
}: Omit<ComponentProps<typeof AriakitComboboxItem>, "store"> & {
  checked?: boolean;
  group?: string;
  icon?: ReactNode;
  label?: string;
  name?: string;
  parentGroup?: string;
  preventClose?: boolean;
  shortcut?: ReactNode;
  shortcutEnter?: boolean;
  value?: string;
} & VariantProps<typeof menuItemVariants>) {
  const menu = useAriakitMenuContext();

  if (!menu) throw new Error("MenuItem should be used inside a Menu");

  const searchable = useContext(SearchableContext);

  const baseProps: MenuItemProps = {
    blurOnHoverEnd: false,
    focusOnHover: true,
    label,
    ...props,
    className: cn(
      menuItemVariants({ isEmpty, variant }),
      (!!shortcut || shortcutEnter) && "justify-between",
      className
    ),
    group: parentGroup,
    name: group,
  };

  baseProps.children = renderMenuItemChildren({
    checked,
    children: baseProps.children,
    icon,
    label,
    searchable,
    shortcut,
    shortcutEnter,
  });

  if (!searchable) {
    if (name != null && props.value != null) {
      const radioProps = {
        ...baseProps,
        hideOnClick: true,
        name,
        value: props.value,
      };

      return <AriakitMenuItemRadio {...radioProps} />;
    }

    return <AriakitMenuItem {...baseProps} />;
  }

  const hideOnClick = (event: MouseEvent<HTMLElement>) => {
    if (shouldKeepMenuOpen(event, preventClose)) return false;

    menu.hideAll();

    return false;
  };

  return <AriakitComboboxItem {...baseProps} hideOnClick={hideOnClick} />;
}

export const comboboxVariants = cva("", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      ai: "min-w-[280px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover py-0.5 shadow-popover",
      default: "mx-3 pt-3.5 pb-1.5",
    },
  },
});

export function ComboboxContent({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof comboboxVariants>) {
  return (
    <div className={cn(comboboxVariants({ variant }), className)} {...props} />
  );
}

const comboboxListVariants = cva(
  cn(
    "group/combobox-list",
    "h-full max-h-[70vh] grow overflow-y-auto rounded-md [&:has(>:last-child:not([role=group]))]:pb-1.5",
    "hidden has-[[role=option]]:block"
  ),
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        ai: "my-1 h-full max-h-[min(40vh,320px)] w-fit min-w-[280px] max-w-[320px] overflow-y-auto bg-popover p-0 shadow-popover",
        default: "",
      },
    },
  }
);

export function ComboboxList({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof AriakitComboboxList> &
  VariantProps<typeof comboboxListVariants>) {
  return (
    <AriakitComboboxList
      className={cn(comboboxListVariants({ variant }), className)}
      {...props}
    />
  );
}

export function ComboboxInput({
  children,
  ...props
}: ComponentProps<typeof AriakitCombobox>) {
  const render = isValidElement(children) ? children : undefined;

  return <AriakitCombobox autoSelect render={render} {...props} />;
}

export function ComboboxEmpty() {
  return (
    <div className="py-1.5 group-has-[[role=option]]/combobox-list:hidden">
      <div className={cn(menuItemVariants({ isEmpty: true }), "")}>
        No results
      </div>
    </div>
  );
}

export function filterMenuItems(
  { items = [], ...group }: Action,
  searchValue: string
): Action[] {
  if (!searchValue) return items;
  if (
    [group.label, ...(group.keywords || [])]
      .join(" ")
      .toLowerCase()
      .includes(searchValue.toLowerCase())
  ) {
    return items;
  }

  return items.filter(
    (item) =>
      item.filterItems ||
      [item.label, item.value, ...(item.keywords || [])]
        .join(" ")
        .toLowerCase()
        .includes(searchValue.toLowerCase())
  );
}

export function filterMenuGroups(
  menuGroups: Action[],
  searchValue: string
): Action[] {
  if (!searchValue) return menuGroups;

  return menuGroups.reduce<Action[]>((acc, group) => {
    const filteredItems = filterMenuItems(group, searchValue);

    if (filteredItems.length > 0) {
      acc.push({
        ...group,
        items: filteredItems,
      });
    }

    return acc;
  }, []);
}

export function useComboboxValueState() {
  const store = useComboboxContext();
  const searchValue = store?.useState("value") ?? "";

  return [searchValue, store?.setValue] as const;
}

export function useMenuSide() {
  const store = useAriakitMenuStore();
  const currentPlacement = store?.useState("currentPlacement").split("-")[0];

  return currentPlacement;
}

export function useContextMenu(anchorRect: { x: number; y: number }) {
  const menu = useAriakitMenuStore();

  useEffect(() => {
    if (anchorRect) {
      menu.render();
    }
  }, [anchorRect, menu]);

  return {
    store: menu,
    getAnchorRect: () => anchorRect,
    show: () => {
      menu.show();
      menu.setAutoFocusOnShow(true);
    },
  };
}

export function useMenuStore() {
  const menu = useAriakitMenuStore();

  return {
    store: menu,
    show: (anchorElement: HTMLElement) => {
      menu.setAnchorElement(anchorElement);
      menu.show();
      menu.setAutoFocusOnShow(true);
    },
  };
}
