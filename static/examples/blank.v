// Any port you leave out is simply not connected.
module top (
  input         CLOCK_50,   // 50 MHz clock (speed set in toolbar)
  input  [17:0] SW,         // slide switches
  input  [3:0]  KEY,        // push buttons, 0 when pressed
  output [17:0] LEDR,       // red LEDs
  output [8:0]  LEDG,       // green LEDs
  output [6:0]  HEX0        // 7-seg, active low, {g,f,e,d,c,b,a}
);
  assign LEDR = SW;
  assign LEDG = 9'b0;
  assign HEX0 = 7'b1111111;
endmodule
