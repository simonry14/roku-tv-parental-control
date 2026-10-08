' Presentation only: every word on screen comes from the Roku TV Parental Control service.

sub init()
    m.icon = m.top.FindNode("icon")
    m.titleLabel = m.top.FindNode("title")
    m.bodyLabel = m.top.FindNode("body")
    m.countdown = m.top.FindNode("countdown")
    m.countdownLabel = m.top.FindNode("countdownLabel")
    m.bar = m.top.FindNode("bar")
    m.drain = m.top.FindNode("drain")
    m.hint = m.top.FindNode("hint")
    m.ticker = m.top.FindNode("ticker")
    m.ticker.ObserveField("fire", "onTick")

    m.remaining = 0
    m.countdownText = ""
    m.countdownEnd = ""
    m.dismissable = true
    m.top.SetFocus(true)
end sub

sub onMessage()
    msg = m.top.message
    if msg = invalid then return

    m.icon.uri = "pkg:/images/" + IconFor(msg.kind) + ".png"
    m.titleLabel.text = msg.title
    m.bodyLabel.text = msg.body
    m.bodyLabel.visible = msg.body <> ""

    m.dismissable = msg.dismissable
    if m.dismissable
        m.hint.text = "Press OK to close"
    else
        m.hint.text = ""
    end if

    ' Restart the countdown for every new message.
    m.ticker.control = "stop"
    m.drain.control = "stop"
    m.remaining = msg.countdown
    m.countdownText = msg.countdownText
    m.countdownEnd = msg.countdownEnd
    if m.remaining > 0 and m.countdownText <> ""
        m.bar.width = 1000
        m.drain.duration = m.remaining
        m.countdown.visible = true
        UpdateCountdown()
        m.drain.control = "start"
        m.ticker.control = "start"
    else
        m.countdown.visible = false
    end if
    Layout()
end sub

' Stack icon, title, body and countdown with fixed gaps, centred on y=520. Measured from the
' labels' bounding boxes, so one- and two-line titles both sit right.
sub Layout()
    nodes = [m.icon, m.titleLabel, m.bodyLabel, m.countdown]
    gapsBefore = [0, 48, 28, 64]
    shown = []
    total = 0
    for i = 0 to nodes.Count() - 1
        node = nodes[i]
        if node.visible
            height = node.BoundingRect().height
            gap = 0
            if shown.Count() > 0 then gap = gapsBefore[i]
            shown.Push({ node: node, gap: gap, height: height })
            total = total + gap + height
        end if
    end for
    y = 520 - total / 2
    for each item in shown
        y = y + item.gap
        item.node.translation = [0, y]
        y = y + item.height
    end for
end sub

sub onTick()
    if m.remaining > 0 then m.remaining = m.remaining - 1
    UpdateCountdown()
    if m.remaining <= 0 then m.ticker.control = "stop"
end sub

sub UpdateCountdown()
    if m.remaining <= 0 and m.countdownEnd <> ""
        m.countdownLabel.text = m.countdownEnd
        return
    end if
    if m.remaining = 1
        unit = "second"
    else
        unit = "seconds"
    end if
    m.countdownLabel.text = Substitute(m.countdownText, m.remaining.ToStr(), unit)
end sub

function IconFor(kind as Dynamic) as String
    for each known in ["blocked", "budget", "schedule", "lock", "warning", "message", "info"]
        if kind = known then return known
    end for
    return "info"
end function

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "OK" or key = "back"
        if m.dismissable then m.top.exitRequested = true
        return true ' on countdown screens, Back does nothing (Home always works)
    end if
    return false
end function
