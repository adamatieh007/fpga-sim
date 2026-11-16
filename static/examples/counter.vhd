-- Demo: switches -> red LEDs, a counter on HEX3..HEX0, switches in hex on HEX7..HEX4
--   KEY(0) = reset (active low, like the real board)
--   KEY(1) = hold to pause the counter
--   LEDG(0) blinks every time the counter ticks
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity top is
  port (
    CLOCK_50 : in  std_logic;
    SW       : in  std_logic_vector(17 downto 0);
    KEY      : in  std_logic_vector(3 downto 0);
    LEDR     : out std_logic_vector(17 downto 0);
    LEDG     : out std_logic_vector(8 downto 0);
    HEX0, HEX1, HEX2, HEX3 : out std_logic_vector(6 downto 0);
    HEX4, HEX5, HEX6, HEX7 : out std_logic_vector(6 downto 0)
  );
end entity;

architecture rtl of top is
  -- On real hardware use 50_000_000 (1 tick per second).
  -- In the simulator keep it small so you can watch it count.
  constant DIVIDE : integer := 25;

  signal div_count : integer range 0 to DIVIDE - 1 := 0;
  signal tick      : std_logic := '0';
  signal count     : unsigned(15 downto 0) := (others => '0');

  -- 7-segment decoder, active low, segment order "gfedcba"
  function to_7seg(v : unsigned(3 downto 0)) return std_logic_vector is
  begin
    case to_integer(v) is
      when 0  => return "1000000";
      when 1  => return "1111001";
      when 2  => return "0100100";
      when 3  => return "0110000";
      when 4  => return "0011001";
      when 5  => return "0010010";
      when 6  => return "0000010";
      when 7  => return "1111000";
      when 8  => return "0000000";
      when 9  => return "0010000";
      when 10 => return "0001000";
      when 11 => return "0000011";
      when 12 => return "1000110";
      when 13 => return "0100001";
      when 14 => return "0000110";
      when others => return "0001110";
    end case;
  end function;
begin
  process (CLOCK_50)
  begin
    if rising_edge(CLOCK_50) then
      if KEY(0) = '0' then
        div_count <= 0;
        count     <= (others => '0');
        tick      <= '0';
      elsif div_count = DIVIDE - 1 then
        div_count <= 0;
        tick      <= not tick;
        if KEY(1) = '1' then
          count <= count + 1;
        end if;
      else
        div_count <= div_count + 1;
      end if;
    end if;
  end process;

  LEDR    <= SW;
  LEDG(0) <= tick;
  LEDG(8 downto 1) <= std_logic_vector(count(7 downto 0)) when SW(17) = '1' else (others => '0');

  HEX0 <= to_7seg(count(3 downto 0));
  HEX1 <= to_7seg(count(7 downto 4));
  HEX2 <= to_7seg(count(11 downto 8));
  HEX3 <= to_7seg(count(15 downto 12));
  HEX4 <= to_7seg(unsigned(SW(3 downto 0)));
  HEX5 <= to_7seg(unsigned(SW(7 downto 4)));
  HEX6 <= to_7seg(unsigned(SW(11 downto 8)));
  HEX7 <= to_7seg(unsigned(SW(15 downto 12)));
end architecture;
