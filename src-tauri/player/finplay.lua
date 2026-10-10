-- Finplay player chrome. Drawn with libass so the picture stays in mpv
-- and the controls match the desktop app.
local mp = require("mp")
local options = require("mp.options")
local assdraw = require("mp.assdraw")

local opts = {
    badge = "", embedded = false, handoff = false, trickplay = false,
    segments = "", next = "", autoskip = false, pip = false, mini = false,
}
options.read_options(opts, "finplay")

local ACCENT = "EA3393"
local HIDE_AFTER = 2.6

local state = {
    last_activity = mp.get_time(),
    menu = nil,
    menu_scroll = 0,
    dragging = false,
    drag_ratio = 0,
    last_drag_seek = 0,
    toast = nil,
    toast_until = 0,
    buttons = {},
    seekbar = nil,
    blank = false,
    thumb = nil,
    thumb_want = nil,
    thumb_sent = 0,
    thumb_at = nil,
    -- Where arrow-key and skip-button seeks are heading, previewed on the bar.
    scrub = nil,
    segments = {},
    skipped = {},
    upnext = nil,
    upnext_cancelled = false,
    next_sent = false,
    last_tick = nil,
    -- Shrunk into a corner of Finplay while the library is browsed.
    mini = opts.mini,
}

local THUMB_OVERLAY = 7

local ass
local width, height, scale = 0, 0, 1
local mouse_x, mouse_y = -1, -1

local LANGS = {
    eng = "English", en = "English", spa = "Spanish", es = "Spanish", fre = "French", fra = "French",
    fr = "French", ger = "German", deu = "German", de = "German", ita = "Italian", it = "Italian",
    jpn = "Japanese", ja = "Japanese", kor = "Korean", ko = "Korean", chi = "Chinese", zho = "Chinese",
    zh = "Chinese", por = "Portuguese", pt = "Portuguese", rus = "Russian", ru = "Russian",
    dut = "Dutch", nld = "Dutch", nl = "Dutch", swe = "Swedish", sv = "Swedish", nor = "Norwegian",
    nob = "Norwegian", dan = "Danish", fin = "Finnish", pol = "Polish", tur = "Turkish", ara = "Arabic",
    hin = "Hindi", tha = "Thai", cze = "Czech", ces = "Czech", hun = "Hungarian", gre = "Greek",
    ell = "Greek", heb = "Hebrew", ukr = "Ukrainian", vie = "Vietnamese", ind = "Indonesian",
}

local CODECS = {
    subrip = "SRT", hdmv_pgs_subtitle = "PGS", dvd_subtitle = "VobSub", ass = "ASS", ssa = "SSA",
    mov_text = "Text", webvtt = "WebVTT", eac3 = "E-AC3", ac3 = "AC3", truehd = "TrueHD",
    dts = "DTS", aac = "AAC", opus = "Opus", flac = "FLAC", mp3 = "MP3", vorbis = "Vorbis",
}

local function now() return mp.get_time() end

local function clamp(value, low, high)
    return math.max(low, math.min(high, value))
end

local function escape(text)
    return (tostring(text):gsub("\\", "\\\\"):gsub("{", "\\{"):gsub("}", "\\}"):gsub("\n", " "))
end

local function format_time(seconds)
    if not seconds or seconds < 0 then
        return "0:00"
    end
    seconds = math.floor(seconds + 0.5)
    local hours = math.floor(seconds / 3600)
    local minutes = math.floor(seconds / 60) % 60
    local secs = seconds % 60
    if hours > 0 then
        return string.format("%d:%02d:%02d", hours, minutes, secs)
    end
    return string.format("%d:%02d", minutes, secs)
end

local function n(value) return string.format("%.1f", value) end

local function shape(path, color, alpha, tags)
    ass:new_event()
    ass:append("{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H" .. color .. "&\\1a&H" .. (alpha or "00") .. "&"
        .. (tags or "") .. "\\p1}" .. path .. "{\\p0}")
end

local function outline(path, size)
    shape(path, "FFFFFF", "FF", "\\bord" .. n(size) .. "\\3c&HFFFFFF&\\3a&H00&")
end

local function rect(x, y, w, h)
    return string.format("m %s %s l %s %s %s %s %s %s", n(x), n(y), n(x + w), n(y), n(x + w), n(y + h), n(x), n(y + h))
end

local function rrect(x, y, w, h, r)
    r = math.min(r, w / 2, h / 2)
    local k = r * 0.4477
    return string.format(
        "m %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s %s %s %s %s",
        n(x + r), n(y), n(x + w - r), n(y),
        n(x + w - k), n(y), n(x + w), n(y + k), n(x + w), n(y + r),
        n(x + w), n(y + h - r),
        n(x + w), n(y + h - k), n(x + w - k), n(y + h), n(x + w - r), n(y + h),
        n(x + r), n(y + h),
        n(x + k), n(y + h), n(x), n(y + h - k), n(x), n(y + h - r),
        n(x), n(y + r),
        n(x), n(y + k), n(x + k), n(y), n(x + r), n(y)
    )
end

local function circle(cx, cy, r)
    return rrect(cx - r, cy - r, r * 2, r * 2, r)
end

local function line(x1, y1, x2, y2, w, color)
    local dx, dy = x2 - x1, y2 - y1
    local length = math.sqrt(dx * dx + dy * dy)
    if length == 0 then return end
    local nx, ny = -dy / length * w / 2, dx / length * w / 2
    shape(string.format("m %s %s l %s %s %s %s %s %s",
        n(x1 + nx), n(y1 + ny), n(x2 + nx), n(y2 + ny), n(x2 - nx), n(y2 - ny), n(x1 - nx), n(y1 - ny)), color)
    shape(circle(x1, y1, w / 2), color)
    shape(circle(x2, y2, w / 2), color)
end

local function text(x, y, align, size, value, color, tags)
    ass:new_event()
    ass:append(string.format("{\\an%d\\pos(%s,%s)\\bord0\\shad0\\fs%s\\1c&H%s&\\1a&H00&%s}%s",
        align, n(x), n(y), n(size * 1.4), color or "FFFFFF", tags or "", escape(value)))
end

local function inside(area, x, y)
    return area and x >= area.x and x <= area.x + area.w and y >= area.y and y <= area.y + area.h
end

local function hovered(x, y, w, h)
    return inside({ x = x, y = y, w = w, h = h }, mouse_x, mouse_y)
end

local function add_button(x, y, w, h, action)
    local area = { x = x, y = y, w = w, h = h, action = action }
    state.buttons[#state.buttons + 1] = area
    return inside(area, mouse_x, mouse_y)
end

local function hit(x, y)
    for index = #state.buttons, 1, -1 do
        if inside(state.buttons[index], x, y) then
            return state.buttons[index]
        end
    end
end

-- Icons, drawn around a centre point at size u.

local function icon_back(cx, cy, u)
    local w = u * 0.12
    line(cx + u * 0.1, cy - u * 0.3, cx - u * 0.2, cy, w, "FFFFFF")
    line(cx - u * 0.2, cy, cx + u * 0.1, cy + u * 0.3, w, "FFFFFF")
end

local function icon_play(cx, cy, u)
    shape(string.format("m %s %s l %s %s %s %s",
        n(cx - u * 0.26), n(cy - u * 0.36), n(cx + u * 0.38), n(cy), n(cx - u * 0.26), n(cy + u * 0.36)), "FFFFFF")
end

local function icon_pause(cx, cy, u)
    shape(rrect(cx - u * 0.28, cy - u * 0.34, u * 0.19, u * 0.68, u * 0.05), "FFFFFF")
    shape(rrect(cx + u * 0.09, cy - u * 0.34, u * 0.19, u * 0.68, u * 0.05), "FFFFFF")
end

local function icon_skip(cx, cy, u, direction)
    local r = u * 0.62
    outline(circle(cx, cy, r), u * 0.07)
    local top = cy - r
    shape(string.format("m %s %s l %s %s %s %s",
        n(cx - direction * u * 0.06), n(top - u * 0.2),
        n(cx + direction * u * 0.24), n(top),
        n(cx - direction * u * 0.06), n(top + u * 0.2)), "FFFFFF")
    text(cx, cy + u * 0.02, 5, u * 0.36, "10", "FFFFFF", "\\b1")
end

local function icon_subtitles(cx, cy, u)
    outline(rrect(cx - u * 0.4, cy - u * 0.3, u * 0.8, u * 0.6, u * 0.1), u * 0.065)
    local h = u * 0.075
    shape(rrect(cx - u * 0.24, cy - u * 0.08, u * 0.14, h, h / 2), "FFFFFF")
    shape(rrect(cx - u * 0.04, cy - u * 0.08, u * 0.28, h, h / 2), "FFFFFF")
    shape(rrect(cx - u * 0.24, cy + u * 0.07, u * 0.3, h, h / 2), "FFFFFF")
    shape(rrect(cx + u * 0.12, cy + u * 0.07, u * 0.12, h, h / 2), "FFFFFF")
end

local function icon_audio(cx, cy, u)
    shape(string.format("m %s %s l %s %s %s %s %s %s %s %s %s %s",
        n(cx - u * 0.38), n(cy - u * 0.12), n(cx - u * 0.2), n(cy - u * 0.12), n(cx + u * 0.02), n(cy - u * 0.32),
        n(cx + u * 0.02), n(cy + u * 0.32), n(cx - u * 0.2), n(cy + u * 0.12), n(cx - u * 0.38), n(cy + u * 0.12)), "FFFFFF")
    local w = u * 0.07
    shape(rrect(cx + u * 0.13, cy - u * 0.14, w, u * 0.28, w / 2), "FFFFFF")
    shape(rrect(cx + u * 0.27, cy - u * 0.26, w, u * 0.52, w / 2), "FFFFFF")
end

local function icon_fullscreen(cx, cy, u)
    local s, l, w = u * 0.34, u * 0.18, u * 0.07
    for _, corner in ipairs({ { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } }) do
        local x = corner[1] < 0 and cx - s or cx + s - l
        local y = corner[2] < 0 and cy - s or cy + s - w
        shape(rect(x, y, l, w), "FFFFFF")
        x = corner[1] < 0 and cx - s or cx + s - w
        y = corner[2] < 0 and cy - s or cy + s - l
        shape(rect(x, y, w, l), "FFFFFF")
    end
end

local function icon_pip(cx, cy, u)
    outline(rrect(cx - u * 0.4, cy - u * 0.3, u * 0.8, u * 0.6, u * 0.08), u * 0.065)
    if state.mini then
        shape(rrect(cx - u * 0.26, cy - u * 0.17, u * 0.3, u * 0.2, u * 0.04), "FFFFFF")
    else
        shape(rrect(cx - u * 0.04, cy - u * 0.03, u * 0.3, u * 0.2, u * 0.04), "FFFFFF")
    end
end

local function icon_close(cx, cy, u)
    local s, w = u * 0.24, u * 0.11
    line(cx - s, cy - s, cx + s, cy + s, w, "FFFFFF")
    line(cx - s, cy + s, cx + s, cy - s, w, "FFFFFF")
end

local function icon_chapters(cx, cy, u)
    local w = u * 0.07
    for index = -1, 1 do
        local y = cy + index * u * 0.22
        shape(circle(cx - u * 0.28, y, u * 0.08), "FFFFFF")
        shape(rrect(cx - u * 0.1, y - w / 2, u * 0.42, w, w / 2), "FFFFFF")
    end
end

local function icon_speed(cx, cy, u)
    outline(circle(cx, cy, u * 0.36), u * 0.07)
    text(cx, cy + u * 0.02, 5, u * 0.28, "1x", "FFFFFF", "\\b1")
end

local SPEEDS = { 0.75, 1.0, 1.25, 1.5, 1.75, 2.0 }

-- Actions.

local function app_message(name)
    mp.commandv("script-message", name)
end

local function go_back()
    if opts.embedded or opts.handoff then
        app_message("finplay-back")
    else
        mp.command("quit")
    end
end

local function toggle_fullscreen()
    if opts.embedded or opts.handoff then
        app_message("finplay-fullscreen")
    else
        mp.command("cycle fullscreen")
    end
end

local function toggle_mini()
    if opts.pip then
        app_message("finplay-mini")
    end
end

local function toggle_pause()
    if mp.get_property_bool("eof-reached") then
        mp.commandv("seek", "0", "absolute")
        mp.set_property_bool("pause", false)
    else
        mp.command("cycle pause")
    end
end

local function skip(seconds)
    -- Repeated presses land before the seek does, so count from the last target.
    local duration = mp.get_property_number("duration") or 0
    local from = state.scrub and now() < state.scrub.ends and state.scrub.time or mp.get_property_number("time-pos") or 0
    if duration > 0 then
        state.scrub = { time = clamp(from + seconds, 0, duration), ends = now() + 1.5 }
    end
    mp.commandv("seek", tostring(seconds), "relative", "exact")
end

local function toast(message)
    state.toast = message
    state.toast_until = now() + 1.4
end

local function set_speed(value)
    mp.set_property_number("speed", value)
    if value == math.floor(value) then
        toast(string.format("Speed %dx", value))
    else
        toast(string.format("Speed %gx", value))
    end
end

local function nudge_speed(direction)
    local current = mp.get_property_number("speed") or 1
    local best, distance = SPEEDS[1], math.huge
    for _, speed in ipairs(SPEEDS) do
        local gap = math.abs(speed - current)
        if gap < distance then
            best, distance = speed, gap
        end
    end
    local index = 1
    for i, speed in ipairs(SPEEDS) do
        if speed == best then index = i end
    end
    set_speed(SPEEDS[clamp(index + direction, 1, #SPEEDS)])
end

local function change_volume(step)
    local volume = clamp((mp.get_property_number("volume") or 100) + step, 0, 130)
    mp.set_property_number("volume", volume)
    toast(string.format("Volume %d%%", math.floor(volume + 0.5)))
end

local function open_menu(kind)
    if state.menu == kind then
        state.menu = nil
    else
        state.menu = kind
        state.menu_scroll = 0
    end
end

-- Tracks.

local function tracks(kind)
    local list = {}
    for _, track in ipairs(mp.get_property_native("track-list") or {}) do
        if track.type == kind then
            list[#list + 1] = track
        end
    end
    return list
end

local function channels(count)
    if count == 1 then return "Mono" end
    if count == 2 then return "Stereo" end
    if count == 6 then return "5.1" end
    if count == 8 then return "7.1" end
    return count .. " ch"
end

local function track_label(track)
    local lang = track.lang and (LANGS[track.lang:lower()] or track.lang:upper()) or nil
    local title = track.title
    if title and title ~= "" then
        if lang and not title:lower():find(lang:lower(), 1, true) then
            return lang .. " · " .. title
        end
        return title
    end
    return lang or ("Track " .. track.id)
end

local function track_detail(track)
    local parts = {}
    if track.codec then
        parts[#parts + 1] = CODECS[track.codec] or track.codec:upper()
    end
    if track.type == "audio" and track["demux-channel-count"] then
        parts[#parts + 1] = channels(track["demux-channel-count"])
    end
    if track.forced then parts[#parts + 1] = "Forced" end
    if track.default then parts[#parts + 1] = "Default" end
    if track.external then parts[#parts + 1] = "External" end
    return table.concat(parts, " · ")
end

-- Drawing.

local function gradient(y, h, dark_at_top)
    local steps = math.max(16, math.floor(h / 4))
    local step = h / steps
    for index = 0, steps - 1 do
        local t = (index + 0.5) / steps
        local darkness = dark_at_top and (1 - t) or t
        local alpha = 255 - math.floor((darkness ^ 1.5) * 190)
        -- Whole-pixel bands that meet exactly; overlapping ones leave darker seams on bright video.
        local top = math.floor(y + step * index)
        local bottom = math.floor(y + step * (index + 1))
        shape(rect(0, top, width, bottom - top), "000000", string.format("%02X", alpha))
    end
end

local function round_button(cx, cy, r, draw_icon, action, filled)
    local over = add_button(cx - r, cy - r, r * 2, r * 2, action)
    if over then
        shape(circle(cx, cy, r), "FFFFFF", "C8")
    elseif filled then
        shape(circle(cx, cy, r), "000000", "90")
    end
    draw_icon(cx, cy, r * 1.05)
end

local function menu_title(kind)
    if kind == "sub" then return "Subtitles" end
    if kind == "audio" then return "Audio" end
    if kind == "chapter" then return "Chapters" end
    if kind == "speed" then return "Speed" end
    return "Menu"
end

local function menu_rows(kind)
    local rows = {}
    if kind == "sub" or kind == "audio" then
        local list = tracks(kind)
        if kind == "sub" then
            local any = false
            for _, track in ipairs(list) do
                if track.selected then any = true end
            end
            rows[1] = { label = "Off", detail = "", selected = not any, pick = function() mp.set_property("sid", "no") end }
        end
        for _, track in ipairs(list) do
            -- Copy id: Lua 5.1 loop variables are shared across closures.
            local id = track.id
            local prop = kind == "sub" and "sid" or "aid"
            rows[#rows + 1] = {
                label = track_label(track),
                detail = track_detail(track),
                selected = track.selected,
                pick = function()
                    mp.set_property_number(prop, id)
                end,
            }
        end
        return rows, #rows == (kind == "sub" and 1 or 0) and "No tracks in this file" or nil
    end
    if kind == "chapter" then
        local chapters = mp.get_property_native("chapter-list") or {}
        local current = mp.get_property_number("chapter")
        for index, chapter in ipairs(chapters) do
            local at = chapter.time or 0
            local title = (chapter.title and chapter.title ~= "" and chapter.title) or ("Chapter " .. index)
            rows[#rows + 1] = {
                label = title,
                detail = format_time(at),
                selected = current == index - 1,
                pick = function()
                    mp.commandv("seek", tostring(at), "absolute")
                end,
            }
        end
        return rows, #rows == 0 and "No chapters in this file" or nil
    end
    if kind == "speed" then
        local current = mp.get_property_number("speed") or 1
        for _, speed in ipairs(SPEEDS) do
            local value = speed
            rows[#rows + 1] = {
                label = value == 1 and "Normal" or (tostring(value) .. "x"),
                detail = "",
                selected = math.abs(current - value) < 0.01,
                pick = function() set_speed(value) end,
            }
        end
        return rows, nil
    end
    return rows, nil
end

local function draw_menu(pad)
    local kind = state.menu
    local rows, empty = menu_rows(kind)

    local panel_w = math.min(360 * scale, width - pad * 2)
    local x = width - pad - panel_w
    local y = pad + 58 * scale
    local header = 46 * scale
    local row_h = 50 * scale
    local room = math.max(1, math.floor((height - y - 150 * scale - header) / row_h))
    local shown = math.min(#rows, room)
    state.menu_scroll = clamp(state.menu_scroll, 0, math.max(0, #rows - shown))
    local panel_h = header + math.max(shown, 1) * row_h + 10 * scale

    add_button(x, y, panel_w, panel_h, function() end)
    shape(rrect(x, y, panel_w, panel_h, 14 * scale), "161616", "12")
    text(x + 20 * scale, y + header / 2, 4, 16 * scale, menu_title(kind), "FFFFFF", "\\b1")
    if #rows > shown then
        text(x + panel_w - 20 * scale, y + header / 2, 6, 12 * scale,
            string.format("%d–%d of %d", state.menu_scroll + 1, state.menu_scroll + shown, #rows), "A0A0A8")
    end
    if #rows == 0 then
        text(x + 20 * scale, y + header + row_h / 2, 4, 14 * scale, empty or "Nothing here", "A0A0A8")
        return
    end

    for index = 1, shown do
        local row = rows[index + state.menu_scroll]
        local ry = y + header + (index - 1) * row_h
        local pick = row.pick
        local over = add_button(x + 6 * scale, ry, panel_w - 12 * scale, row_h, function()
            -- Always close the menu even if the action errors, so controls stay usable.
            local ok, err = pcall(pick)
            state.menu = nil
            if not ok then
                toast(tostring(err):match(":[%d]+:%s*(.*)$") or "Couldn't apply that")
            end
        end)
        if over then
            shape(rrect(x + 6 * scale, ry + 2 * scale, panel_w - 12 * scale, row_h - 4 * scale, 10 * scale), "FFFFFF", "E6")
        end
        if row.selected then
            shape(circle(x + 24 * scale, ry + row_h / 2, 5 * scale), ACCENT)
        end
        local label_x = x + 42 * scale
        local tags = row.selected and "\\b1" or ""
        if row.detail ~= "" then
            text(label_x, ry + row_h / 2 - 1 * scale, 1, 15 * scale, row.label, "FFFFFF", tags .. "\\q2")
            text(label_x, ry + row_h / 2 + 2 * scale, 7, 12 * scale, row.detail, "A0A0A8", "\\q2")
        else
            text(label_x, ry + row_h / 2, 4, 15 * scale, row.label, "FFFFFF", tags .. "\\q2")
        end
    end
end

-- Trickplay previews. The app renders the frame and replies with
-- finplay-thumb-ready; mpv overlays draw raw BGRA files above the OSD.

local function request_thumb(seconds)
    local want = math.floor(seconds)
    if want == state.thumb_want or now() - state.thumb_sent < 0.06 then return end
    state.thumb_want = want
    state.thumb_sent = now()
    local thumb_width = math.floor(clamp(260 * scale, 160, 420))
    mp.commandv("script-message", "finplay-thumb", tostring(want), tostring(thumb_width))
end

local function show_thumb(x, y)
    local thumb = state.thumb
    x, y = math.floor(x), math.floor(y)
    local key = string.format("%s:%d:%d", thumb.path, x, y)
    if state.thumb_at == key then return end
    state.thumb_at = key
    mp.commandv("overlay-add", tostring(THUMB_OVERLAY), tostring(x), tostring(y), thumb.path, "0", "bgra",
        tostring(thumb.w), tostring(thumb.h), tostring(thumb.w * 4))
end

local function hide_thumb()
    if state.thumb_at then
        mp.commandv("overlay-remove", tostring(THUMB_OVERLAY))
        state.thumb_at = nil
    end
    state.thumb = nil
    state.thumb_want = nil
end

mp.register_script_message("finplay-thumb-ready", function(path, w, h)
    local width, height = tonumber(w), tonumber(h)
    if not path or not width or not height or state.thumb_want == nil then return end
    state.thumb = { path = path, w = width, h = height }
    state.thumb_at = nil
end)

local function seek_ratio(x)
    local bar = state.seekbar
    if not bar then return 0 end
    return clamp((x - bar.track_x) / bar.track_w, 0, 1)
end

local function seek_to(ratio, exact)
    local duration = mp.get_property_number("duration") or 0
    if duration <= 0 then return end
    state.drag_ratio = ratio
    mp.commandv("seek", tostring(ratio * duration), exact and "absolute+exact" or "absolute+keyframes")
end

-- Skip markers come from Jellyfin media segments, or failing that from
-- chapter names. Up next counts down during the credits or at the end.

local SKIP_LABELS = {
    Intro = "Skip intro", Recap = "Skip recap", Preview = "Skip preview",
    Commercial = "Skip ad", Outro = "Skip credits",
}
local UP_NEXT_SECONDS = 10

local CHAPTER_KINDS = {
    { "Intro", { "intro", "opening", "^op$", "^op ", "title sequence" } },
    { "Recap", { "recap", "previously" } },
    { "Outro", { "credits", "outro", "^ending", "^ed$", "^ed ", "end title" } },
    { "Preview", { "preview", "next episode" } },
}

local function parse_segments()
    local list = {}
    for kind, start, stop in opts.segments:gmatch("(%a+):([%d%.]+):([%d%.]+)") do
        start, stop = tonumber(start), tonumber(stop)
        if SKIP_LABELS[kind] and start and stop and stop - start >= 2 then
            list[#list + 1] = { kind = kind, start = start, stop = stop }
        end
    end
    return list
end

local function chapter_segments()
    local chapters = mp.get_property_native("chapter-list") or {}
    local duration = mp.get_property_number("duration") or 0
    local list = {}
    for index, chapter in ipairs(chapters) do
        local title = (chapter.title or ""):lower()
        for _, entry in ipairs(CHAPTER_KINDS) do
            local matched = false
            for _, pattern in ipairs(entry[2]) do
                if title:find(pattern) then
                    matched = true
                    break
                end
            end
            if matched then
                local following = chapters[index + 1]
                local stop = following and following.time or (duration > 0 and duration or 1e9)
                if stop - chapter.time >= 2 then
                    list[#list + 1] = { kind = entry[1], start = chapter.time, stop = stop }
                end
                break
            end
        end
    end
    return list
end

state.segments = parse_segments()

mp.register_event("file-loaded", function()
    if #state.segments == 0 then
        state.segments = chapter_segments()
    end
end)

local function current_segment(position)
    for _, segment in ipairs(state.segments) do
        if position >= segment.start and position < segment.stop - 0.5 then
            return segment
        end
    end
end

local function play_next()
    if state.next_sent then return end
    state.next_sent = true
    app_message("finplay-next")
end

local function short(value, limit)
    if #value <= limit then return value end
    return value:sub(1, limit - 1):gsub("[\128-\191]+$", ""):gsub("[\192-\255]$", "") .. "…"
end

-- Runs every frame of the overlay timer, even with the controls hidden.
local function update_markers(position, paused, ended)
    local t = now()
    local dt = state.last_tick and math.min(t - state.last_tick, 0.5) or 0
    state.last_tick = t

    local segment = current_segment(position)
    if segment and opts.autoskip and (segment.kind == "Intro" or segment.kind == "Recap") and not state.skipped[segment] then
        state.skipped[segment] = true
        mp.commandv("seek", tostring(segment.stop), "absolute+exact")
        toast(segment.kind == "Intro" and "Skipped intro" or "Skipped recap")
        return nil
    end

    local has_next = opts.next ~= ""
    local credits = false
    for _, entry in ipairs(state.segments) do
        if entry.kind == "Outro" and position >= entry.start and position <= entry.stop + 1 then
            credits = true
        end
    end
    if has_next and (credits or ended) then
        if not state.upnext_cancelled then
            state.upnext = state.upnext or { remaining = UP_NEXT_SECONDS }
            if ended or not paused then
                state.upnext.remaining = state.upnext.remaining - dt
            end
            if state.upnext.remaining <= 0 then
                play_next()
            end
        end
    else
        state.upnext = nil
        state.upnext_cancelled = false
    end

    if segment and not (credits and has_next) then
        return segment
    end
    return nil
end

local function draw_skip(segment, controls_shown, pad)
    local w, h = 168 * scale, 46 * scale
    local x = width - pad - w
    local y = height - pad - h - (controls_shown and 92 or 16) * scale
    local over = add_button(x, y, w, h, function()
        mp.commandv("seek", tostring(segment.stop), "absolute+exact")
    end)
    shape(rrect(x, y, w, h, 12 * scale), over and "FFFFFF" or "161616", over and "00" or "30")
    if not over then
        outline(rrect(x, y, w, h, 12 * scale), 1.2 * scale)
    end
    text(x + w / 2, y + h / 2, 5, 15 * scale, SKIP_LABELS[segment.kind], over and "000000" or "FFFFFF", "\\b1")
end

local function draw_upnext(controls_shown, pad)
    local w, h = 400 * scale, 132 * scale
    local x = width - pad - w
    local y = height - pad - h - (controls_shown and 92 or 16) * scale
    add_button(x, y, w, h, function() end)
    shape(rrect(x, y, w, h, 16 * scale), "161616", "18")
    local left = x + 20 * scale
    text(left, y + 24 * scale, 4, 12 * scale, "UP NEXT", "A0A0A8", "\\b1")
    text(left, y + 50 * scale, 4, 17 * scale, short(opts.next, 40), "FFFFFF", "\\b1\\q2")
    local seconds = math.max(0, math.ceil(state.upnext.remaining))
    text(x + w - 20 * scale, y + 24 * scale, 6, 12 * scale, string.format("Playing in %ds", seconds), "C8C8D0")

    local bw, bh = 140 * scale, 38 * scale
    local by = y + h - bh - 18 * scale
    local play_over = add_button(left, by, bw, bh, play_next)
    shape(rrect(left, by, bw, bh, bh / 2), ACCENT, play_over and "00" or "18")
    local progress = 1 - clamp(state.upnext.remaining / UP_NEXT_SECONDS, 0, 1)
    if progress > 0 then
        shape(rrect(left, by, math.max(bh, bw * progress), bh, bh / 2), "FFFFFF", "C0")
    end
    text(left + bw / 2, by + bh / 2, 5, 14 * scale, "Play now", "FFFFFF", "\\b1")

    local cx = left + bw + 12 * scale
    local cancel_over = add_button(cx, by, bw, bh, function()
        state.upnext = nil
        state.upnext_cancelled = true
    end)
    shape(rrect(cx, by, bw, bh, bh / 2), "FFFFFF", cancel_over and "C8" or "E6")
    text(cx + bw / 2, by + bh / 2, 5, 14 * scale, "Cancel", "FFFFFF", "\\b1")
end

local function render()
    local t = now()
    width, height = mp.get_osd_size()
    local mouse = mp.get_property_native("mouse-pos") or {}
    mouse_x, mouse_y = mouse.x or -1, mouse.y or -1
    local paused = mp.get_property_bool("pause")
    local ended = mp.get_property_bool("eof-reached")
    local idle = t - state.last_activity > HIDE_AFTER
    local away = mouse.hover == false

    state.buttons = {}
    state.seekbar = nil

    local skip_segment = update_markers(mp.get_property_number("time-pos") or 0, paused, ended)
    local show_controls = not ((idle or away) and not paused and not ended and not state.menu and not state.dragging)
    -- mpv cannot hide the cursor once Finplay hosts its video, so Finplay does.
    local hide_cursor = opts.embedded and not show_controls and not away and not state.mini
    if hide_cursor ~= state.cursor_hidden then
        state.cursor_hidden = hide_cursor
        if hide_cursor then mp.commandv("script-message", "finplay-hide-cursor") end
    end
    local show_toast = state.toast and t < state.toast_until
    local show_extra = skip_segment ~= nil or state.upnext ~= nil
    if width == 0 or (not show_controls and not show_toast and not show_extra) then
        hide_thumb()
        if not state.blank then
            mp.set_osd_ass(width, height, "")
            state.blank = true
            state.last_ass = ""
        end
        return
    end
    state.blank = false

    if state.mini then
        scale = clamp(math.min(width / 900, height / 506), 0.5, 1)
    else
        scale = clamp(math.min(width / 1400, height / 820), 0.7, 2)
    end
    local pad = 28 * scale
    ass = assdraw.ass_new()
    local previewing = false

    if show_controls then
        local position = mp.get_property_number("time-pos") or 0
        local duration = mp.get_property_number("duration") or 0
        local buffering = mp.get_property_bool("paused-for-cache") or mp.get_property_native("time-pos") == nil

        gradient(0, 150 * scale, true)
        gradient(height - 170 * scale, 170 * scale, false)

        local top = pad + 22 * scale
        local right = width - pad - 22 * scale
        if state.mini then
            -- Mini: close and expand only; menus need the full player.
            round_button(pad + 22 * scale, top, 22 * scale, icon_close, go_back, true)
            round_button(right, top, 22 * scale, icon_pip, toggle_mini, true)
        else
            -- Top bar: back, title, track menus, picture-in-picture, fullscreen.
            round_button(pad + 22 * scale, top, 22 * scale, icon_back, go_back, true)
            local title = mp.get_property("force-media-title") or mp.get_property("media-title") or ""
            text(pad + 60 * scale, top - 2 * scale, 1, 20 * scale, title, "FFFFFF", "\\b1\\q2")
            local badge = opts.badge
            if ended then
                badge = "Finished"
            elseif badge == "" and paused then
                badge = "Paused"
            end
            if badge ~= "" then
                text(pad + 60 * scale, top + 3 * scale, 7, 13 * scale, badge, "C8C8D0", "\\q2")
            end
            local buttons = { { icon_fullscreen, toggle_fullscreen } }
            if opts.pip then
                buttons[#buttons + 1] = { icon_pip, toggle_mini }
            end
            buttons[#buttons + 1] = { icon_speed, function() open_menu("speed") end }
            buttons[#buttons + 1] = { icon_chapters, function() open_menu("chapter") end }
            buttons[#buttons + 1] = { icon_subtitles, function() open_menu("sub") end }
            buttons[#buttons + 1] = { icon_audio, function() open_menu("audio") end }
            for index, button in ipairs(buttons) do
                round_button(right - (index - 1) * 54 * scale, top, 22 * scale, button[1], button[2], true)
            end
        end

        -- Centre transport.
        local cx, cy = width / 2, height / 2
        round_button(cx - 120 * scale, cy, 30 * scale, function(x, y, u) icon_skip(x, y, u, -1) end, function() skip(-10) end, false)
        round_button(cx + 120 * scale, cy, 30 * scale, function(x, y, u) icon_skip(x, y, u, 1) end, function() skip(10) end, false)
        round_button(cx, cy, 42 * scale, (paused or ended) and icon_play or icon_pause, toggle_pause, true)
        if buffering and not paused then
            text(cx, cy + 62 * scale, 8, 14 * scale, "Buffering…", "E0E0E8")
        end

        -- Seek bar.
        local track_x = pad
        local track_w = math.max(1, width - pad * 2)
        local bar_y = height - pad - 34 * scale
        state.seekbar = { x = track_x - 8 * scale, y = bar_y - 14 * scale, w = track_w + 16 * scale, h = 28 * scale,
            track_x = track_x, track_w = track_w }
        local over_bar = inside(state.seekbar, mouse_x, mouse_y) and not state.menu
        local thick = (over_bar or state.dragging) and 6 * scale or 4 * scale
        local ratio = duration > 0 and clamp(position / duration, 0, 1) or 0
        if state.dragging then ratio = state.drag_ratio end
        shape(rrect(track_x, bar_y - thick / 2, track_w, thick, thick / 2), "FFFFFF", "B0")
        local cache = mp.get_property_number("demuxer-cache-time")
        if cache and duration > 0 then
            local buffered = clamp(cache / duration, 0, 1)
            if buffered > ratio then
                shape(rrect(track_x, bar_y - thick / 2, track_w * buffered, thick, thick / 2), "FFFFFF", "80")
            end
        end
        if ratio > 0 then
            shape(rrect(track_x, bar_y - thick / 2, math.max(thick, track_w * ratio), thick, thick / 2), ACCENT)
        end
        local scrubbing = state.scrub and t < state.scrub.ends and not state.menu
        if (over_bar or state.dragging or scrubbing) and show_controls then
            shape(circle(track_x + track_w * ratio, bar_y, 8 * scale), "FFFFFF")
            if duration > 0 then
                local hover_ratio
                if state.dragging then
                    hover_ratio = state.drag_ratio
                elseif over_bar then
                    hover_ratio = seek_ratio(mouse_x)
                else
                    hover_ratio = clamp(state.scrub.time / duration, 0, 1)
                end
                if opts.trickplay and not state.mini then
                    previewing = true
                    request_thumb(hover_ratio * duration)
                    if state.thumb then
                        local tw, th = state.thumb.w, state.thumb.h
                        local tx = math.floor(clamp(track_x + track_w * hover_ratio - tw / 2, pad, width - pad - tw))
                        local ty = math.floor(bar_y - 56 * scale - th)
                        -- A frame around the picture, never under it: some VOs
                        -- composite the ASS layer above overlays.
                        local frame = 3
                        shape(rect(tx - frame, ty - frame, tw + frame * 2, frame), "161616", "10")
                        shape(rect(tx - frame, ty + th, tw + frame * 2, frame), "161616", "10")
                        shape(rect(tx - frame, ty, frame, th), "161616", "10")
                        shape(rect(tx + tw, ty, frame, th), "161616", "10")
                        show_thumb(tx, ty)
                    end
                end
                local tip_x = clamp(track_x + track_w * hover_ratio, pad + 34 * scale, width - pad - 34 * scale)
                shape(rrect(tip_x - 34 * scale, bar_y - 46 * scale, 68 * scale, 26 * scale, 8 * scale), "161616", "20")
                text(tip_x, bar_y - 33 * scale, 5, 13 * scale, format_time(hover_ratio * duration), "FFFFFF", "\\b1")
            end
        end
        local shown_position = state.dragging and state.drag_ratio * duration or position
        text(track_x, bar_y + 16 * scale, 7, 14 * scale, format_time(shown_position), "FFFFFF")
        text(track_x + track_w, bar_y + 16 * scale, 9, 14 * scale,
            "-" .. format_time(math.max(0, duration - shown_position)), "C8C8D0")

        if state.menu and not state.mini then
            draw_menu(pad)
        end
    end
    -- Overlays outlive the ASS frame, so a preview nobody is pointing at must go.
    if not previewing then
        hide_thumb()
    end

    if state.upnext then
        draw_upnext(show_controls, pad)
    elseif skip_segment then
        draw_skip(skip_segment, show_controls, pad)
    end

    if show_toast then
        local tw = 150 * scale
        shape(rrect(width / 2 - tw / 2, pad, tw, 36 * scale, 18 * scale), "161616", "30")
        text(width / 2, pad + 18 * scale, 5, 15 * scale, state.toast, "FFFFFF", "\\b1")
    end

    -- An unchanged overlay would still make libass re-rasterise and mpv redraw.
    local key = width .. "x" .. height .. ass.text
    if key ~= state.last_ass then
        state.last_ass = key
        mp.set_osd_ass(width, height, ass.text)
    end
end

local function active()
    state.last_activity = now()
end

-- Input.

-- Run input/OSD work inside pcall so one bad action (e.g. a menu pick) can
-- never leave Space / arrows / the overlay dead for the rest of the session.
local function safe(fn)
    return function(...)
        local ok, err = pcall(fn, ...)
        if not ok then
            mp.msg.error("finplay: " .. tostring(err))
        end
    end
end

local function on_left(event)
    local x, y = mouse_x, mouse_y
    local position = mp.get_property_native("mouse-pos")
    if position then x, y = position.x, position.y end
    if event.event == "down" or event.event == "press" then
        local was_hidden = state.blank
        active()
        render()
        if was_hidden then
            return
        end
        if event.event == "down" and not state.menu and inside(state.seekbar, x, y) then
            state.dragging = true
            state.last_drag_seek = now()
            seek_to(seek_ratio(x), false)
            render()
            return
        end
        local button = hit(x, y)
        if button then
            pcall(button.action)
        elseif state.menu then
            state.menu = nil
        else
            -- Remember the state before a click run so a double-click can restore it.
            if not state.click_at or now() - state.click_at > 1 then
                state.click_paused = mp.get_property_bool("pause")
            end
            state.click_at = now()
            toggle_pause()
        end
        render()
    elseif event.event == "up" and state.dragging then
        state.dragging = false
        seek_to(seek_ratio(x), true)
        render()
    end
end

local function on_double()
    local position = mp.get_property_native("mouse-pos") or {}
    local x, y = position.x or -1, position.y or -1
    if hit(x, y) or inside(state.seekbar, x, y) then
        return
    end
    -- Both clicks of a double-click also arrive as single clicks, and each may
    -- have toggled pause, so put pause back to how it was before them.
    if state.click_at and now() - state.click_at < 1 and state.click_paused ~= nil then
        mp.set_property_bool("pause", state.click_paused)
    end
    state.click_at = nil
    toggle_fullscreen()
end

local function on_move()
    active()
    if state.dragging then
        local position = mp.get_property_native("mouse-pos") or {}
        state.drag_ratio = seek_ratio(position.x or 0)
        if now() - state.last_drag_seek > 0.15 then
            state.last_drag_seek = now()
            seek_to(state.drag_ratio, false)
        end
    end
    render()
end

local function on_wheel(direction)
    return function()
        active()
        local position = mp.get_property_native("mouse-pos") or {}
        local over_menu = false
        for _, button in ipairs(state.buttons) do
            if state.menu and inside(button, position.x or -1, position.y or -1) then
                over_menu = true
            end
        end
        if over_menu then
            state.menu_scroll = state.menu_scroll - direction
        else
            change_volume(direction * 5)
        end
        render()
    end
end

local function on_escape()
    if state.menu then
        state.menu = nil
        render()
    elseif opts.embedded or opts.handoff then
        app_message("finplay-escape")
    elseif mp.get_property_bool("fullscreen") then
        mp.set_property_bool("fullscreen", false)
    end
end

local function key(fn)
    return function()
        active()
        -- Always refresh the chrome, even when the action errors.
        pcall(fn)
        pcall(render)
    end
end

mp.add_forced_key_binding("MBTN_LEFT", "finplay-click", safe(on_left), { complex = true })
mp.add_forced_key_binding("MBTN_LEFT_DBL", "finplay-double", safe(on_double))
mp.add_forced_key_binding("MOUSE_MOVE", "finplay-move", safe(on_move))
mp.add_forced_key_binding("WHEEL_UP", "finplay-wheel-up", safe(on_wheel(1)))
mp.add_forced_key_binding("WHEEL_DOWN", "finplay-wheel-down", safe(on_wheel(-1)))
-- A binding's name is also a script message that runs it. These must not share
-- a name with an app_message, or sending it runs the binding, which sends it
-- again, forever: the app then toggles fullscreen as fast as it can.
mp.add_forced_key_binding("ESC", "finplay-key-escape", safe(on_escape))
mp.add_forced_key_binding("BS", "finplay-key-back", key(go_back))
mp.add_forced_key_binding("f", "finplay-key-fullscreen", key(toggle_fullscreen))
mp.add_forced_key_binding("SPACE", "finplay-pause", key(toggle_pause))
mp.add_forced_key_binding("LEFT", "finplay-rewind", key(function() skip(-10) end))
mp.add_forced_key_binding("RIGHT", "finplay-forward", key(function() skip(10) end))
mp.add_forced_key_binding("UP", "finplay-volume-up", key(function() change_volume(5) end))
mp.add_forced_key_binding("DOWN", "finplay-volume-down", key(function() change_volume(-5) end))
mp.add_forced_key_binding("a", "finplay-audio", key(function() open_menu("audio") end))
mp.add_forced_key_binding("s", "finplay-subs", key(function() open_menu("sub") end))
mp.add_forced_key_binding("c", "finplay-chapters", key(function() open_menu("chapter") end))
mp.add_forced_key_binding("[", "finplay-speed-down", key(function() nudge_speed(-1) end))
mp.add_forced_key_binding("]", "finplay-speed-up", key(function() nudge_speed(1) end))
mp.add_forced_key_binding("p", "finplay-pip", key(toggle_mini))

mp.register_script_message("finplay-mini-state", function(value)
    state.mini = value == "yes"
    state.menu = nil
    hide_thumb()
    active()
    pcall(render)
end)

-- Mouse and key handlers render straight away, so a paused, untouched player
-- only needs a slow refresh (for the clock and buffering state).
local last_refresh = 0
local function tick()
    local t = now()
    local busy = state.dragging or state.menu or (state.toast and t < state.toast_until) or t - state.last_activity < HIDE_AFTER
    if mp.get_property_bool("pause") and not busy and t - last_refresh < 1 then
        return
    end
    last_refresh = t
    render()
end
mp.add_periodic_timer(0.1, safe(tick))
mp.register_event("seek", active)
mp.observe_property("pause", "bool", function() active() end)
active()
