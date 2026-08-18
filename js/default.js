/*
 * Plain ES5, no library: every API used here (querySelectorAll, classList,
 * addEventListener, the hidden property) predates the flexbox and grid the
 * stylesheet already relies on, so this runs anywhere the site renders.
 */
(function () {
	"use strict";

	function all(selector, root) {
		return Array.prototype.slice.call((root || document).querySelectorAll(selector));
	}

	// --- menu ---------------------------------------------------------------
	// Last match wins, so /about/ marks About rather than Apps, whose href "/"
	// prefixes every path on the site.
	var selected = null;
	var menu = all(".menu a");
	for (var i = menu.length - 1; i >= 0; i--) {
		if (location.pathname.indexOf(menu[i].getAttribute("href")) === 0) {
			menu[i].className += " active";
			selected = menu[i];
			break;
		}
	}

	// The address is assembled here rather than published in the markup.
	var mail = document.querySelector(".mail");
	if (mail) {
		mail.setAttribute("href", "mai" + "lto" + ":mx" + "julien" + "@" + "gmail" + "." + "com");
	}

	// The back arrow returns to the section the page belongs to.
	var back = document.querySelector(".back");
	if (back && selected) {
		back.addEventListener("click", function () {
			location.href = selected.getAttribute("href");
		});
	}

	// --- language menu ------------------------------------------------------
	// <details> has no light dismiss of its own: without this the list stays
	// open until the summary is clicked again.
	function closeLangMenus(event) {
		var open = all("details.cc-langs-toggle[open]");
		for (var i = 0; i < open.length; i++) {
			if (!event || !open[i].contains(event.target)) open[i].removeAttribute("open");
		}
	}

	document.addEventListener("click", closeLangMenus);
	document.addEventListener("keyup", function (event) {
		// "Esc" is what Internet Explorer and old Edge report.
		if (event.key === "Escape" || event.key === "Esc" || event.keyCode === 27) {
			closeLangMenus(null);
		}
	});

	// --- platform filter (home page) ----------------------------------------
	var filter = document.querySelector(".app-filter");
	if (filter) {
		var cards = all(".app-card");
		var buttons = all(".app-filter-btn", filter);

		var runsOn = function (card, platform) {
			return platform === "all" ||
				(card.getAttribute("data-platform") || "").split(" ").indexOf(platform) !== -1;
		};

		var countFor = function (platform) {
			var n = 0;
			for (var i = 0; i < cards.length; i++) if (runsOn(cards[i], platform)) n++;
			return n;
		};

		for (var b = 0; b < buttons.length; b++) {
			// The counts ship in the markup so a crawler reads them; this only
			// keeps them honest if a card is added and the number is not.
			var badge = buttons[b].querySelector(".app-filter-count");
			if (badge) badge.textContent = countFor(buttons[b].getAttribute("data-platform"));

			buttons[b].addEventListener("click", function () {
				var platform = this.getAttribute("data-platform");
				for (var i = 0; i < buttons.length; i++) {
					var on = buttons[i] === this;
					buttons[i].className = on ? "app-filter-btn is-on" : "app-filter-btn";
					buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
				}
				for (var c = 0; c < cards.length; c++) {
					cards[c].hidden = !runsOn(cards[c], platform);
				}
			});
		}

		// Revealed only once the handlers are attached, so the bar is never a
		// control that cannot filter anything.
		filter.removeAttribute("hidden");
	}

	// --- tag page -----------------------------------------------------------
	if (location.pathname.indexOf("/tag/") === 0) {
		var heading = document.querySelector("h1");
		var posts = all(".posts li");

		// Written into a span of its own: rewriting the whole heading would take
		// the back arrow, which is one of its children, down with it.
		var label = null;
		var setHeading = function (text) {
			if (!heading) return;
			if (!label) {
				label = document.createElement("span");
				for (var i = heading.childNodes.length - 1; i >= 0; i--) {
					if (heading.childNodes[i].nodeType === 3) heading.removeChild(heading.childNodes[i]);
				}
				heading.appendChild(label);
			}
			label.textContent = text;
		};

		var applyTag = function () {
			var tag = location.hash;
			setHeading("TAG " + tag);
			for (var i = 0; i < posts.length; i++) {
				var rel = (posts[i].getAttribute("rel") || "").toLowerCase();
				posts[i].hidden = rel.indexOf(tag.toLowerCase() + ",") === -1;
			}
		};

		applyTag();
		// Covers the tag links, the browser's Back button and a pasted URL alike.
		window.addEventListener("hashchange", applyTag);
	}
})();
