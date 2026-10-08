' Roku TV Parental Control: the "Time's up" channel.
'
' The Roku TV Parental Control service on the PC opens this channel over ECP with the message to show:
'
'   POST http://<tv>:8060/launch/dev?v=1&kind=schedule&t=<title>&b=<body>&cd=30&ct=<text>&ce=<text>&ok=0
'
'   kind  blocked | budget | schedule | lock | warning | message | info   (picks the icon)
'   t, b  title and body, base64url-encoded UTF-8 (no padding), so no character needs URL escaping
'   cd    countdown in seconds (0 or absent = no countdown)
'   ct    countdown text; ^0 is replaced by the seconds left and ^1 by "second"/"seconds"
'   ce    text shown when the countdown reaches zero
'   ok    "0" = OK and Back do nothing (countdown screens); anything else = they close the channel
'
' A message sent while the channel is already open arrives as an roInputEvent with the same fields
' (the service uses POST /input?... for that). Opened from the Home screen, with no message, the
' channel shows a short "ready" screen. Closing the channel returns to the Home screen.

sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("MessageScene")
    screen.Show()

    input = CreateObject("roInput")
    input.SetMessagePort(port)

    scene.ObserveField("exitRequested", port)
    scene.message = ParseMessage(args)

    while true
        msg = Wait(0, port)
        msgType = Type(msg)
        if msgType = "roSGScreenEvent"
            if msg.IsScreenClosed() then return
        else if msgType = "roInputEvent"
            if msg.IsInput() then scene.message = ParseMessage(msg.GetInfo())
        else if msgType = "roSGNodeEvent"
            if msg.GetField() = "exitRequested" then screen.Close()
        end if
    end while
end sub

function ParseMessage(args as Dynamic) as Object
    msg = {
        kind: "info",
        title: "Parental Control is ready",
        body: "Messages about TV time will show up here.",
        countdown: 0,
        countdownText: "",
        countdownEnd: "",
        dismissable: true
    }
    if Type(args) <> "roAssociativeArray" then return msg

    title = DecodeText(ArgString(args, "t"))
    if title = "" then return msg ' opened from the Home screen, not by the service

    msg.kind = LCase(ArgString(args, "kind"))
    msg.title = title
    msg.body = DecodeText(ArgString(args, "b"))
    msg.countdownText = DecodeText(ArgString(args, "ct"))
    msg.countdownEnd = DecodeText(ArgString(args, "ce"))
    countdown = ArgString(args, "cd")
    if countdown <> "" then msg.countdown = countdown.ToInt()
    if msg.countdown < 0 then msg.countdown = 0
    msg.dismissable = ArgString(args, "ok") <> "0"
    return msg
end function

' Launch and input parameters arrive as strings; anything else is treated as missing.
function ArgString(args as Object, key as String) as String
    value = args.Lookup(key)
    valueType = Type(value)
    if valueType = "String" or valueType = "roString" then return value
    return ""
end function

' base64url (RFC 4648 section 5, padding optional) to text.
function DecodeText(value as String) as String
    if value = "" then return ""
    s = value.Replace("-", "+").Replace("_", "/")
    remainder = Len(s) MOD 4
    if remainder = 2
        s = s + "=="
    else if remainder = 3
        s = s + "="
    end if
    bytes = CreateObject("roByteArray")
    bytes.FromBase64String(s)
    return bytes.ToAsciiString()
end function
