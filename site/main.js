(() => {
  const menu = document.querySelector(".menu-toggle");
  const nav = document.querySelector("#navigation");
  const closeMenu = () => {
    menu.setAttribute("aria-expanded", "false");
    nav.classList.remove("is-open");
  };
  menu.addEventListener("click", () => {
    const open = menu.getAttribute("aria-expanded") !== "true";
    menu.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  });
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      closeMenu();
      menu.focus();
    }
  });

  const tabs = [...document.querySelectorAll("[data-device]")];
  function selectTab(tab) {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden =
        !selected;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      if (event.key === "ArrowLeft")
        next = tabs[(index + tabs.length - 1) % tabs.length];
      if (event.key === "Home") next = tabs[0];
      if (event.key === "End") next = tabs.at(-1);
      if (next) {
        event.preventDefault();
        selectTab(next);
        next.focus();
      }
    });
  });

  const copy = document.getElementById("copy-command");
  copy.addEventListener("click", async () => {
    const status = document.getElementById("copy-status");
    try {
      await navigator.clipboard.writeText(
        document.getElementById("command").textContent,
      );
      copy.textContent = "Copied ✓";
      status.textContent = "Quick-start commands copied.";
      setTimeout(() => {
        copy.textContent = "Copy ⧉";
      }, 2200);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("command"));
      selection.removeAllRanges();
      selection.addRange(range);
      copy.textContent = "Select & copy";
      status.textContent = "Commands selected. Use your device’s copy command.";
    }
  });

  const dialog = document.getElementById("screenshot-dialog");
  document.querySelectorAll("[data-preview]").forEach((button) =>
    button.addEventListener("click", () => {
      const img = document.getElementById("preview-image");
      img.src = button.dataset.preview;
      img.alt = button.querySelector("img").alt;
      document.getElementById("preview-caption").textContent =
        button.dataset.caption;
      dialog.showModal();
    }),
  );
  dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    )
      dialog.close();
  });
})();
