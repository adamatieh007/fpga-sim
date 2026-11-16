// Demo: switches -> red LEDs, a counter on HEX3..HEX0, switches in hex on HEX7..HEX4
//   KEY[0] = reset (active low, like the real board)
//   KEY[1] = hold to pause the counter
//   LEDG[0] blinks every time the counter ticks
module seg7_decoder (
  input  [3:0] v,
  output reg [6:0] seg      // active low, order {g,f,e,d,c,b,a}
);
  always_comb begin
    case (v)
      4'h0: seg = 7'b1000000;
      4'h1: seg = 7'b1111001;
      4'h2: seg = 7'b0100100;
      4'h3: seg = 7'b0110000;
      4'h4: seg = 7'b0011001;
      4'h5: seg = 7'b0010010;
      4'h6: seg = 7'b0000010;
      4'h7: seg = 7'b1111000;
      4'h8: seg = 7'b0000000;
      4'h9: seg = 7'b0010000;
      4'hA: seg = 7'b0001000;
      4'hB: seg = 7'b0000011;
      4'hC: seg = 7'b1000110;
      4'hD: seg = 7'b0100001;
      4'hE: seg = 7'b0000110;
      default: seg = 7'b0001110;
    endcase
  end
endmodule

module top (
  input         CLOCK_50,
  input  [17:0] SW,
  input  [3:0]  KEY,
  output [17:0] LEDR,
  output [8:0]  LEDG,
  output [6:0]  HEX0, HEX1, HEX2, HEX3, HEX4, HEX5, HEX6, HEX7
);
  // On real hardware use 50_000_000 (1 tick per second).
  // In the simulator keep it small so you can watch it count.
  localparam DIVIDE = 25;

  reg [31:0] div_count = 0;
  reg        tick = 0;
  reg [15:0] count = 0;

  always @(posedge CLOCK_50) begin
    if (KEY[0] == 1'b0) begin
      div_count <= 0;
      count     <= 0;
      tick      <= 0;
    end else if (div_count == DIVIDE - 1) begin
      div_count <= 0;
      tick      <= ~tick;
      if (KEY[1] == 1'b1) begin
        count <= count + 1;
      end
    end else begin
      div_count <= div_count + 1;
    end
  end

  assign LEDR = SW;
  assign LEDG[0] = tick;
  assign LEDG[8:1] = SW[17] ? count[7:0] : 8'b0;

  seg7_decoder h0 (.v(count[3:0]),   .seg(HEX0));
  seg7_decoder h1 (.v(count[7:4]),   .seg(HEX1));
  seg7_decoder h2 (.v(count[11:8]),  .seg(HEX2));
  seg7_decoder h3 (.v(count[15:12]), .seg(HEX3));
  seg7_decoder h4 (.v(SW[3:0]),      .seg(HEX4));
  seg7_decoder h5 (.v(SW[7:4]),      .seg(HEX5));
  seg7_decoder h6 (.v(SW[11:8]),     .seg(HEX6));
  seg7_decoder h7 (.v(SW[15:12]),    .seg(HEX7));
endmodule
