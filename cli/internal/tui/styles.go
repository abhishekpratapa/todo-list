package tui

import (
	"image/color"

	"charm.land/lipgloss/v2"
)

// Styles are the board's colors, taken from the app's own stylesheet
// (public/styles.css) in its light and dark forms.
type Styles struct {
	Text, Muted, Faint          lipgloss.Style
	Title, TitleDone            lipgloss.Style
	Accent, Danger, Warn, OK    lipgloss.Style
	Info, Claude                lipgloss.Style
	Tile, TileActive, TileAlert lipgloss.Style
	Column, ColumnFocused       lipgloss.Style
	Card, CardSelected          lipgloss.Style
	Pane                        lipgloss.Style
	StatusBar, Error, Banner    lipgloss.Style
	border, accent              color.Color
}

func newStyles(dark bool) Styles {
	ld := lipgloss.LightDark(dark)
	c := func(light, darkHex string) color.Color { return ld(lipgloss.Color(light), lipgloss.Color(darkHex)) }
	var (
		text       = c("#1c1c1a", "#ecebe6")
		muted      = c("#6a6a64", "#a3a29b")
		faint      = c("#9a9a93", "#75746e")
		border     = c("#c9c9c2", "#42423d")
		surface    = c("#e2e2dd", "#2a2a27")
		accent     = c("#5b5bd6", "#8b8bf0")
		accentText = c("#ffffff", "#141414")
		claude     = c("#c96442", "#e08a68")
		danger     = c("#c9372c", "#f0776c")
		warn       = c("#a96500", "#e2a64a")
		ok         = c("#2b8a57", "#5cc28a")
		info       = c("#2f6fd6", "#79a6f2")
	)
	fg := func(col color.Color) lipgloss.Style { return lipgloss.NewStyle().Foreground(col) }
	box := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1)
	return Styles{
		Text: fg(text), Muted: fg(muted), Faint: fg(faint),
		Title: fg(text).Bold(true), TitleDone: fg(faint),
		Accent: fg(accent), Danger: fg(danger), Warn: fg(warn), OK: fg(ok), Info: fg(info), Claude: fg(claude),
		Tile:          fg(muted).Padding(0, 1),
		TileActive:    lipgloss.NewStyle().Foreground(accentText).Background(accent).Bold(true).Padding(0, 1),
		TileAlert:     fg(danger).Padding(0, 1),
		Column:        box.BorderForeground(border),
		ColumnFocused: box.BorderForeground(accent),
		Card:          lipgloss.NewStyle(),
		CardSelected:  lipgloss.NewStyle().Background(surface),
		Pane:          box.BorderForeground(accent),
		StatusBar:     fg(muted),
		Error:         fg(danger),
		Banner:        lipgloss.NewStyle().Foreground(accentText).Background(warn).Padding(0, 1),
		border:        border, accent: accent,
	}
}
